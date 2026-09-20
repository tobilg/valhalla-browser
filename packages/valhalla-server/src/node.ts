/** @module valhalla-server/node */
import { Worker } from 'node:worker_threads';
import { AdmissionQueue, deadline } from '@tobilg/valhalla-core/queue';
import { RoutingError, cancelled } from '@tobilg/valhalla-core/errors';
import { validateRequest } from '@tobilg/valhalla-core/profiles';
import { resolveSearchMemory } from '@tobilg/valhalla-core/search-memory';
import { resolveWasmMemory, NODE_WASM_MEMORY } from '@tobilg/valhalla-core/wasm-memory';
import type { ThreadOperations, ThreadRequest, ThreadResponse } from './thread-protocol.js';
import type { ServerOptions, OperationOptions, StartupResult, RouteRequest, RouteResult, Diagnostics } from './types.js';
export * from './index.js';

/** Node configuration. Dataset URLs must be absolute HTTP(S) URLs. */
export interface RouterOptions extends ServerOptions {
  /** Versioned dataset manifest; graph data is fetched selectively over HTTP. */
  manifestUrl: string;
}

/** A Node session with a dedicated worker thread and bounded FIFO admission. */
export class Router {
  /** Session configuration. Changes apply after thread replacement. */
  readonly options: RouterOptions;
  /** Most recent successful initialization; cleared on thread replacement. */
  startup?: StartupResult;
  private readonly queue: AdmissionQueue;
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private termination: Promise<unknown> = Promise.resolve();
  private active?: AbortController;
  private activeDone?: Promise<void>;
  private closed = false;

  /** Construct a lazy session. No thread or graph downloads start here. */
  constructor(options: RouterOptions) {
    let url: URL;
    try { url = new URL(options.manifestUrl); } catch { throw new RoutingError('INVALID_REQUEST', 'An absolute HTTP(S) manifest URL is required.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RoutingError('INVALID_REQUEST', 'An absolute HTTP(S) manifest URL without credentials is required.');
    resolveSearchMemory(options.searchMemory);
    resolveWasmMemory(options.wasmMemory, NODE_WASM_MEMORY);
    this.options = { ...options, manifestUrl: url.href };
    this.queue = new AdmissionQueue(options.maxQueuedRoutes, options.queueTimeoutMs);
  }

  private async stopWorker(reason: RoutingError): Promise<void> {
    const worker = this.worker;
    this.worker = undefined; this.startup = undefined;
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
    if (worker) this.termination = worker.terminate();
    await this.termination;
  }

  private async ensureWorker(): Promise<void> {
    await this.termination;
    if (this.worker) return;
    const worker = new Worker(new URL('./node-worker.js', import.meta.url));
    this.worker = worker;
    worker.on('message', (message: ThreadResponse) => {
      if (worker !== this.worker) return;
      if (message.type === 'progress') {
        try { this.options.onProgress?.({ ...message.detail, requestId: message.id }); } catch {}
        return;
      }
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === 'error') entry?.reject(new RoutingError(message.error.code, message.error.message, message.error));
      else entry?.resolve(message.result);
    });
    const failed = (cause: unknown) => {
      if (worker === this.worker) void this.stopWorker(new RoutingError('WORKER_FAILED', 'Routing thread failed.', { cause })).catch(() => {});
    };
    worker.on('error', failed);
    worker.on('exit', code => failed(new Error(`Routing thread exited (${code}).`)));
  }

  private send<K extends keyof ThreadOperations>(type: K, payload: Omit<ThreadOperations[K], 'result'>): Promise<ThreadOperations[K]['result']> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as ThreadOperations[K]['result']), reject });
      try { this.worker!.postMessage({ id, type, ...payload } as ThreadRequest); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private async ready(): Promise<StartupResult> {
    if (this.startup) return this.startup;
    const begin = performance.now();
    await this.ensureWorker();
    this.active?.signal.throwIfAborted();
    const { manifestUrl, transport, timeoutMs, retries, memoryBudgetBytes, searchMemory, wasmMemory } = this.options;
    const result = await this.send('initialize', { options: { manifestUrl, transport, timeoutMs, retries, memoryBudgetBytes, searchMemory, wasmMemory } });
    return this.startup = { ...result, runtimeReadyMs: performance.now() - begin };
  }

  private async run<T>(options: OperationOptions, action: (queueWaitMs: number, start: number) => Promise<T>): Promise<T> {
    if (this.closed) throw new RoutingError('DISPOSED', 'Router disposed.');
    const start = performance.now();
    const control = deadline(options.signal, this.options.routeTimeoutMs ?? 30000);
    let release: (() => void) | undefined;
    let finished: (() => void) | undefined;
    const abort = () => { void this.stopWorker(control.signal.reason).catch(() => {}); };
    try {
      release = await this.queue.acquire(control.signal);
      control.signal.throwIfAborted();
      this.active = control.controller;
      this.activeDone = new Promise(resolve => { finished = resolve; });
      control.signal.addEventListener('abort', abort, { once: true });
      return await action(performance.now() - start, start);
    } catch (error) {
      if (release && (!this.startup || error instanceof RoutingError && ['RUNTIME', 'RESOURCE_LIMIT', 'WORKER_FAILED'].includes(error.code)))
        await this.stopWorker(error instanceof RoutingError ? error : new RoutingError('RUNTIME', 'Routing thread failed.', { cause: error }));
      throw control.signal.aborted ? control.signal.reason : error;
    } finally {
      control.signal.removeEventListener('abort', abort); control.cleanup();
      if (release) { await this.termination; this.active = undefined; finished?.(); this.activeDone = undefined; release(); }
    }
  }

  /** Initialize the thread and graph, respecting admission and operation deadlines. */
  initialize(options: OperationOptions = {}): Promise<StartupResult> { return this.run(options, () => this.ready()); }

  /** Calculate a real native route. Active abort terminates the thread; queued callers recover on a new thread. */
  async route(request: RouteRequest, options: OperationOptions = {}): Promise<RouteResult> {
    const normalized = validateRequest(request);
    return this.run(options, async (queueWaitMs, start) => {
      await this.ready();
      this.active?.signal.throwIfAborted();
      const result = await this.send('route', { request: normalized });
      return { ...result, diagnostics: { ...result.diagnostics, queueWaitMs, hostRouteMs: performance.now() - start } };
    });
  }

  /** Read accumulated diagnostics, initializing lazily and queuing behind active work. */
  diagnostics(options: OperationOptions = {}): Promise<Diagnostics> {
    return this.run(options, async () => { await this.ready(); return { ...await this.send('diagnostics', {}), resourceTiming: null, cooperativeCheckpoints: 0 }; });
  }

  /** Cancel every outstanding operation and await termination. Later calls may start a new thread. */
  async cancel(): Promise<void> {
    this.queue.rejectWaiting(cancelled()); this.active?.abort(cancelled());
    await this.stopWorker(cancelled()); await this.activeDone;
  }

  /** Permanently close the session and await thread termination. */
  async dispose(): Promise<void> { this.closed = true; this.queue.close(); await this.cancel(); }
}

/** Construct and initialize a Node router. Dispose the returned session when finished. */
export async function createRouter(options: RouterOptions): Promise<Router> {
  const router = new Router(options);
  try { await router.initialize(); return router; }
  catch (error) { await router.dispose(); throw error; }
}
