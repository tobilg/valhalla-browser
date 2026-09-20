/** @module valhalla-browser */
import { workerUrl as defaultWorkerUrl, wasmUrl as defaultWasmUrl } from 'virtual:runtime-assets';
import { RoutingError, cancelled } from './errors.js';
import type { Operations, WorkerRequest, WorkerResponse } from './protocol.js';
import type { Diagnostics, RouteRequest, RouteResult, RouterOptions, StartupResult } from './types.js';
import { validateRequest } from './profiles.js';
import { resolveWasmMemory } from '@tobilg/valhalla-core/wasm-memory';
export { RoutingError } from './errors.js';
export type { RoutingErrorCode, RoutingErrorOptions, SerializedRoutingError } from './errors.js';
export type * from './types.js';
export type { NormalizedRequest } from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: RoutingError) => void;
  cleanup: () => void;
}

/** A lazy browser routing session. Native operations are serialized in one dedicated Web Worker. */
export class Router {
  /** Session configuration; relative manifest and asset URLs resolve against the page. */
  readonly options: RouterOptions;
  /** Measurements from the most recent successful initialization; cleared on cancellation or failure. */
  startup?: StartupResult;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private disposed = false;
  private worker?: Worker;
  private ready?: Promise<StartupResult>;
  private bootstrapUrl?: string;
  private bootTimer?: ReturnType<typeof setTimeout>;

  /**
   * Create a browser session without downloading the engine.
   * @param options - Dataset, transport, memory, lifecycle and asset settings.
   * @remarks Requires a browser location. Call {@link initialize} or {@link route} to start.
   */
  constructor(options: RouterOptions) {
    this.options = { ...options, manifestUrl: new URL(options.manifestUrl, location.href).href };
  }

  private createWorker(): Worker {
    if (this.options.workerFactory) return this.options.workerFactory();
    const url = new URL(this.options.workerUrl ?? defaultWorkerUrl, location.href);
    let entry = url.href;
    if (url.origin !== location.origin) {
      // A static import finishes module evaluation before queued init messages run.
      // Absolute URLs also prevent resolving runtime assets against the blob URL.
      this.bootstrapUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(entry)};`], { type: 'text/javascript' }));
      entry = this.bootstrapUrl;
    }
    return new Worker(entry, { type: 'module', name: 'valhalla-routing' });
  }

  private releaseBootstrap(): void {
    if (this.bootTimer !== undefined) clearTimeout(this.bootTimer);
    this.bootTimer = undefined;
    if (this.bootstrapUrl) URL.revokeObjectURL(this.bootstrapUrl);
    this.bootstrapUrl = undefined;
  }

  /**
   * Load the runtime and pinned dataset metadata. Concurrent calls share startup.
   * @returns Initialization timings and dataset/native identity.
   * @throws {@link RoutingError} for asset, dataset, network, cancellation or disposed-session failures.
   * @remarks A failed initialization can be retried on the same Router.
   * An opaque browser worker-load failure or WASM initialization timeout gets at
   * most one shared startup retry in a fresh worker, unless `retries` is zero or
   * a custom `workerFactory` is used. Native routing operations are never replayed.
   * Cancellation also stops this startup recovery.
   */
  async initialize(): Promise<StartupResult> {
    if (this.disposed) throw new RoutingError('DISPOSED', 'Router is disposed.');
    if (this.ready) return this.ready;
    resolveWasmMemory(this.options.wasmMemory);
    const started = performance.now();
    let worker: Worker;
    let wasmUrl: string;
    try {
      wasmUrl = new URL(this.options.wasmUrl ?? defaultWasmUrl, location.href).href;
      worker = this.createWorker();
    } catch (cause) {
      this.releaseBootstrap();
      throw new RoutingError('WORKER_FAILED', 'Cannot create routing worker. Check asset URLs and CSP.', { cause });
    }
    const { manifestUrl, transport, timeoutMs, retries, memoryBudgetBytes, searchMemory, wasmMemory } = this.options;
    const payload = { options: { manifestUrl, transport, timeoutMs, retries, memoryBudgetBytes, searchMemory, wasmMemory, wasmUrl } };
    const initializeId = ++this.sequence;
    let bootRetries = 0;
    const retryStartup = (worker: Worker): boolean => {
      if (worker !== this.worker || !this.pending.has(initializeId) ||
          this.options.workerFactory || retries === 0 || bootRetries >= 1) return false;
      bootRetries++;
      // Only initialization is pending here. Terminate before creating a fresh
      // instance, and invalidate old handlers immediately (including during backoff).
      this.worker = undefined;
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      this.releaseBootstrap();
      this.bootTimer = setTimeout(() => {
        if (!this.pending.has(initializeId) || this.disposed) return;
        try {
          const replacement = this.createWorker();
          attach(replacement);
          replacement.postMessage({ id: initializeId, type: 'initialize', ...payload } satisfies WorkerRequest);
        } catch (cause) {
          this.reset(new RoutingError('WORKER_FAILED', 'Cannot restart routing worker.', { cause }));
        }
      }, 100);
      return true;
    };
    const attach = (worker: Worker): void => {
      this.worker = worker;
      let acknowledged = false;
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (worker !== this.worker) return;
        acknowledged = true;
        this.releaseBootstrap();
        if (data.type === 'ready') return;
        const entry = this.pending.get(data.id);
        if (!entry) return;
        if (data.type === 'progress') {
          if (data.detail.phase === 'loading-runtime') {
            this.bootTimer = setTimeout(() => {
              if (worker !== this.worker || retryStartup(worker)) return;
              this.reset(new RoutingError('TIMEOUT', 'WASM runtime initialization timed out.', { retryable: true }));
            // Small tile-fetch budgets must not abort healthy WASM compilation.
            }, Math.max(10000, this.options.timeoutMs ?? 10000));
          }
          try { this.options.onProgress?.({ requestId: data.id, ...data.detail }); } catch { /* Diagnostics must not break routing. */ }
          return;
        }
        this.pending.delete(data.id);
        entry.cleanup();
        if (data.type === 'error') {
          const error = new RoutingError(data.error.code, data.error.message, data.error);
          entry.reject(error);
          if (['RUNTIME', 'RESOURCE_LIMIT', 'WORKER_FAILED'].includes(error.code)) this.reset(error);
        } else entry.resolve(data.result);
      };
      worker.onerror = event => {
        event.preventDefault();
        if (worker !== this.worker) return;
        // An opaque module-load failure can be transient (including immediately
        // after termination). Retry once, before the worker has acknowledged any
        // message. Never replay routing/native operations or custom worker protocols.
        if (!acknowledged && !event.message && retryStartup(worker)) return;
        this.reset(new RoutingError('WORKER_FAILED', event.message || 'Worker failed. Check asset URLs and CSP.'));
      };
      worker.onmessageerror = () => {
        if (worker === this.worker) this.reset(new RoutingError('WORKER_FAILED', 'Invalid worker message.'));
      };
      // Some browsers report blocked module imports only through the console.
      // Custom workerFactory implementations retain the original protocol without a ready handshake.
      if (!this.options.workerFactory) {
        this.bootTimer = setTimeout(() => {
          if (worker === this.worker) this.reset(new RoutingError('WORKER_FAILED', 'Routing worker did not start. Check asset URLs, CORS, and CSP.'));
        }, this.options.timeoutMs ?? 10000);
      }
    };
    attach(worker);
    const ready: Promise<StartupResult> = this.send('initialize', payload, undefined, initializeId).then(result => {
      const startup = { ...result, workerReadyMs: performance.now() - started };
      this.startup = startup;
      return startup;
    }).catch(error => {
      if (this.ready === ready) this.reset(error);
      throw error;
    });
    this.ready = ready;
    return ready;
  }

  private send<K extends keyof Operations>(type: K, payload: Operations[K]['payload'], signal?: AbortSignal, id = ++this.sequence): Promise<Operations[K]['result']> {
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel();
      this.pending.set(id, { resolve: value => resolve(value as Operations[K]['result']), reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        this.worker!.postMessage({ id, type, ...payload } as WorkerRequest);
      } catch (cause) {
        this.reset(new RoutingError('WORKER_FAILED', 'Cannot send request to routing worker.', { cause }));
      }
    });
  }

  /**
   * Calculate a road route with the selected profile, initializing lazily and queuing behind other native operations.
   * @param request - Start/end coordinates and the optional profile and matching settings.
   * @returns Complete native JSON, dataset identity and per-route measurements.
   * @throws {@link RoutingError} for invalid input, coverage/no-route, transport or lifecycle failures.
   * @remarks Aborting the signal terminates the worker and rejects all pending operations,
   * including other queued routes. A subsequent route starts a new worker with an empty cache.
   */
  async route(request: RouteRequest, { signal }: { signal?: AbortSignal } = {}): Promise<RouteResult> {
    const started = performance.now();
    const normalized = validateRequest(request);
    if (signal?.aborted) throw cancelled();
    const abortInitialization = () => this.cancel();
    signal?.addEventListener('abort', abortInitialization, { once: true });
    try { await this.initialize(); }
    finally { signal?.removeEventListener('abort', abortInitialization); }
    if (signal?.aborted) throw cancelled();
    const result = await this.send('route', { request: normalized }, signal);
    return { ...result, diagnostics: { ...result.diagnostics, hostRouteMs: performance.now() - started } };
  }

  private reset(error: RoutingError): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
    this.startup = undefined;
    this.releaseBootstrap();
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear();
  }

  /** Reject all outstanding operations with `CANCELLED`, terminate the worker, and discard its memory cache. The Router remains reusable. */
  cancel(): void { this.reset(cancelled()); }

  /** Read cumulative tile/cache/heap diagnostics, initializing lazily if necessary. Queues behind active routing. Traces include tile URLs and IDs. */
  async diagnostics(): Promise<Diagnostics> { await this.initialize(); return this.send('diagnostics', {}); }

  /** Permanently close this session, terminate its worker, and reject outstanding operations. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.reset(new RoutingError('DISPOSED', 'Router is disposed.'));
  }
}

/**
 * Create and initialize a browser Router.
 * @param options - Dataset, transport, memory and asset settings.
 * @returns An initialized session. Call {@link Router.dispose} when finished.
 * @throws {@link RoutingError} if the runtime or dataset cannot initialize.
 * @remarks Use `new Router(options)` instead when you need to retain the instance
 * and retry initialization after a failure.
 */
export async function createRouter(options: RouterOptions): Promise<Router> {
  const router = new Router(options);
  await router.initialize();
  return router;
}
