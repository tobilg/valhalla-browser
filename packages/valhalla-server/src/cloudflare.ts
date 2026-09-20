/** @module valhalla-server/cloudflare */
import createModule from '../../../public/wasm/valhalla.js';
import wasmModule from '../../../public/wasm/valhalla.wasm';
import { instantiateRuntime } from '@tobilg/valhalla-core/runtime';
import { resolveWasmMemory, CLOUDFLARE_WASM_MEMORY } from '@tobilg/valhalla-core/wasm-memory';
import { Engine } from '@tobilg/valhalla-core/engine';
import { HttpStore } from '@tobilg/valhalla-core/store';
import { AdmissionQueue, deadline } from '@tobilg/valhalla-core/queue';
import { RoutingError, asError, cancelled } from '@tobilg/valhalla-core/errors';
import { validateRequest } from '@tobilg/valhalla-core/profiles';
import { resolveSearchMemory } from '@tobilg/valhalla-core/search-memory';
import { R2Store } from './r2-store.js';
import type { ServerOptions, OperationOptions as BaseOperationOptions, StartupResult, RouteRequest, RouteResult, Diagnostics, ServerLoaderMetrics } from './types.js';
import type { LoaderMetrics } from '@tobilg/valhalla-core/types';
export * from './index.js';

/** Experimental Cloudflare HTTP source. Use an immutable versioned manifest. */
export interface HttpSource {
  /** Select HTTP delivery through public object storage/CDN. */
  type: 'http';
  /** Absolute HTTP(S) manifest URL. */
  manifestUrl: string;
}
/** Private R2 source. No public URL or storage credentials are required. */
export interface R2Source {
  /** Select direct binding reads. */
  type: 'r2';
  /** R2 capability from the Worker environment; no request-owned objects. */
  bucket: R2Bucket;
  /** Manifest object key, including its immutable version directory. */
  manifestKey: string;
}
/** Experimental Cloudflare session configuration. */
export interface RouterOptions extends ServerOptions {
  /** Graph source, fixed for the lifetime of this session. */
  source: HttpSource | R2Source;
}
/** Each operation belongs to the current Worker request. */
export interface OperationOptions extends BaseOperationOptions {
  /** Current request context; keeps native cleanup alive after disconnection. */
  context: Pick<ExecutionContext, 'waitUntil'>;
}
const unavailableTiming = (metrics: LoaderMetrics): ServerLoaderMetrics => ({ ...metrics, sequentialWaitMs: null });

/** Experimental single-isolate router. Construct once; supply a fresh context per call. */
export class Router {
  /** Configuration for this fixed graph session. */
  readonly options: RouterOptions;
  /** Most recent successful startup. Timings are null on this platform. */
  startup?: StartupResult;
  private readonly queue: AdmissionQueue;
  private readonly store: HttpStore | R2Store;
  private readonly manifestUrl: string;
  private engine: Engine;
  private active?: AbortController;
  private closed = false;
  private sequence = 0;
  private cooperativeCheckpoints = 0;
  private activeId?: number;

  /** Construct without doing I/O or initializing WASM outside a request. */
  constructor(options: RouterOptions) {
    resolveSearchMemory(options.searchMemory);
    resolveWasmMemory(options.wasmMemory, CLOUDFLARE_WASM_MEMORY);
    this.options = { ...options };
    this.queue = new AdmissionQueue(options.maxQueuedRoutes, options.queueTimeoutMs);
    if (options.source.type === 'r2') {
      const store = new R2Store(options.source.bucket, options.source.manifestKey);
      this.store = store; this.manifestUrl = store.manifestUrl;
    } else {
      let url: URL;
      try { url = new URL(options.source.manifestUrl); } catch { throw new RoutingError('INVALID_REQUEST', 'An absolute HTTP(S) manifest URL is required.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new RoutingError('INVALID_REQUEST', 'An absolute HTTP(S) manifest URL without credentials is required.');
      this.manifestUrl = url.href;
      this.store = new HttpStore();
    }
    this.engine = this.newEngine();
  }
  private newEngine(): Engine {
    return new Engine((memory, maximumBytes) => instantiateRuntime(createModule, wasmModule, memory, maximumBytes), detail => {
      try { this.options.onProgress?.({ ...detail, requestId: this.activeId! }); } catch {}
    }, 3, this.store, CLOUDFLARE_WASM_MEMORY);
  }
  private async ready(): Promise<StartupResult> {
    if (this.startup) return this.startup;
    const result = await this.engine.initialize({ ...this.options, manifestUrl: this.manifestUrl });
    return this.startup = { ...result, loader: unavailableTiming(result.loader), moduleStartupMs: null, graphStartupMs: null, runtimeReadyMs: null };
  }
  private run<T>(options: OperationOptions, action: () => Promise<T>): Promise<T> {
    if (!options?.context?.waitUntil) return Promise.reject(new RoutingError('INVALID_REQUEST', 'The current Worker execution context is required.'));
    const operation = this.execute(options, action);
    // This settlement promise is owned by this request, never reused by another.
    options.context.waitUntil(operation.then(() => {}, () => {}));
    return operation;
  }
  private async execute<T>(options: OperationOptions, action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RoutingError('DISPOSED', 'Router disposed.');
    const control = deadline(options.signal, this.options.routeTimeoutMs ?? 30000);
    let release: (() => void) | undefined;
    try {
      release = await this.queue.acquire(control.signal);
      control.signal.throwIfAborted();
      this.active = control.controller; this.activeId = ++this.sequence;
      this.engine.setOperation(control.signal, async () => {
        // A message alone cannot interrupt WASM. Asyncify checkpoints yield to
        // the platform before checking cancellation/deadlines.
        this.cooperativeCheckpoints++;
        await scheduler.wait(0);
        control.signal.throwIfAborted();
      });
      return await action();
    } catch (error) {
      const typed = control.signal.aborted ? control.signal.reason as RoutingError : asError(error);
      if (release && (!this.startup || ['RUNTIME', 'RESOURCE_LIMIT'].includes(typed.code))) {
        try { await this.engine.dispose(); } catch {}
        this.startup = undefined; this.engine = this.newEngine();
      }
      throw typed;
    } finally {
      control.cleanup();
      if (release) { this.engine.setOperation(); this.active = undefined; this.activeId = undefined; release(); }
    }
  }
  /** Initialize within this request, or reuse an already initialized actor. */
  initialize(options: OperationOptions): Promise<StartupResult> { return this.run(options, () => this.ready()); }
  /** Route serially; queued cancellation leaves the active actor untouched. */
  async route(request: RouteRequest, options: OperationOptions): Promise<RouteResult> {
    const normalized = validateRequest(request);
    return this.run(options, async () => {
      await this.ready();
      const result = await this.engine.route(normalized);
      return { ...result, diagnostics: { ...result.diagnostics, loader: unavailableTiming(result.diagnostics.loader), routeMs: null, hostRouteMs: null, queueWaitMs: null } };
    });
  }
  /** Read cumulative counters without browser or unreliable CPU timing fields. */
  diagnostics(options: OperationOptions): Promise<Diagnostics> {
    return this.run(options, async () => {
      await this.ready();
      const result = await this.engine.diagnostics();
      return { ...result, metrics: unavailableTiming(result.metrics), trace: result.trace.map(trace => ({ ...trace, elapsedMs: null })), resourceTiming: null, cooperativeCheckpoints: this.cooperativeCheckpoints };
    });
  }
  /** Permanently close admission, cancel active work and await native cleanup in this request. */
  dispose(options: OperationOptions): Promise<void> {
    if (!options?.context?.waitUntil) return Promise.reject(new RoutingError('INVALID_REQUEST', 'The current Worker execution context is required.'));
    this.closed = true; this.active?.abort(cancelled());
    const operation = (async () => {
      const release = await this.queue.acquireForDisposal();
      try { await this.engine.dispose(); this.startup = undefined; }
      finally { release(); }
    })();
    options.context.waitUntil(operation.then(() => {}, () => {}));
    return operation;
  }
}

/** Construct and initialize an experimental router inside the current request. */
export async function createRouter(options: RouterOptions, operation: OperationOptions): Promise<Router> {
  const router = new Router(options);
  try { await router.initialize(operation); return router; }
  catch (error) { await router.dispose(operation); throw error; }
}
