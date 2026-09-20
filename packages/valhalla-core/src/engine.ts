import { TileLoader, sha256 } from './loader.js';
import { HttpStore, type ObjectStore } from './store.js';
import { RoutingError } from './errors.js';
import { SUPPORTED_COSTINGS, validateRequest } from './profiles.js';
import { resolveSearchMemory } from './search-memory.js';
import { resolveWasmMemory, createWasmMemory, BROWSER_WASM_MEMORY } from './wasm-memory.js';
import type { WasmMemoryOptions, EffectiveWasmMemory } from './types.js';
import type { DatasetManifest, NativeConfig } from './dataset.js';
import type { NormalizedRequest } from './protocol.js';
import type { Diagnostics, LoaderMetrics, NativeRoute, NativeStats, ProgressDetail, SearchMemoryOptions, StartupResult, TileTransport, RouteResult } from './types.js';

export interface RuntimeModule {
  bridgeError?: unknown;
  tileLoader?: TileLoader;
  interrupt?: () => Promise<void>;
  ccall(name: string, result: 'string', types: string[], values: string[], options: { async: true }): Promise<string>;
}
export interface EngineOptions {
  manifestUrl: string;
  transport?: TileTransport;
  timeoutMs?: number;
  retries?: number;
  memoryBudgetBytes?: number;
  searchMemory?: SearchMemoryOptions;
  wasmMemory?: WasmMemoryOptions;
}
export type EngineStartup = Omit<StartupResult, 'workerReadyMs'>;
export type EngineRoute = Omit<RouteResult, 'diagnostics'> & { diagnostics: Omit<RouteResult['diagnostics'], 'hostRouteMs'> };
export type EngineDiagnostics = Omit<Diagnostics, 'resourceTiming'>;

async function documentBytes(url: string | URL, timeoutMs: number, retries: number, metrics: { requests: number; bytes: number }, store: ObjectStore, operationSignal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = operationSignal ? AbortSignal.any([timeout, operationSignal]) : timeout;
    try {
      metrics.requests++;
      signal.throwIfAborted();
      const bytes = await store.document(url, signal);
      metrics.bytes += bytes.length;
      return bytes;
    } catch (error) {
      if (operationSignal?.aborted) throw operationSignal.reason;
      const typed = signal.aborted ? new RoutingError('TIMEOUT', 'Metadata request timed out.', { retryable: true }) :
        error instanceof RoutingError ? error : new RoutingError('NETWORK', 'Metadata download failed.', { retryable: true });
      if (!typed.retryable || attempt >= retries) throw typed;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

/** One actor instance. Its host owns exclusive admission until native cleanup settles. */
export class Engine {
  private module!: RuntimeModule;
  private loader!: TileLoader;
  private manifest!: DatasetManifest;
  private config!: NativeConfig;
  private effectiveConfigSha256 = '';
  private initialized = false;
  startup?: EngineStartup;
  private signal?: AbortSignal;
  private interrupt?: () => Promise<void>;
  setOperation(signal?: AbortSignal, interrupt?: () => Promise<void>): void {
    this.signal = signal; this.interrupt = interrupt;
    if (this.loader) this.loader.signal = signal;
    if (this.module) this.module.interrupt = interrupt;
  }
  constructor(private readonly createModule: (memory: WebAssembly.Memory, maximumBytes: number) => Promise<RuntimeModule>,
    private readonly progress: (detail: ProgressDetail) => void = () => {}, private readonly expectedAbi = 3,
    private readonly store: ObjectStore = new HttpStore(), private readonly defaultWasmMemory: EffectiveWasmMemory = BROWSER_WASM_MEMORY) {}
  private async call<T>(name: string, input?: unknown): Promise<T> {
    if (name !== 'vb_dispose') this.signal?.throwIfAborted();
    this.module.bridgeError = undefined;
    const raw = await this.module.ccall(name, 'string', input === undefined ? [] : ['string'], input === undefined ? [] : [JSON.stringify(input)], { async: true });
    if (this.module.bridgeError) throw this.module.bridgeError;
    if (name !== 'vb_dispose') this.signal?.throwIfAborted();
    const result = JSON.parse(raw) as T & { nativeError?: number; runtimeError?: string };
    if (result.nativeError !== undefined) {
      const code = result.nativeError;
      throw new RoutingError(code === 442 ? 'NO_ROUTE' : code === 171 ? 'LOCATION_NOT_FOUND' : 'NATIVE', `Valhalla error ${code}.`, { nativeCode: code });
    }
    if (result.runtimeError === 'MEMORY') throw new RoutingError('RESOURCE_LIMIT', 'Native routing exhausted its WASM memory budget.');
    if (result.runtimeError) throw new RoutingError('RUNTIME', `Valhalla ${result.runtimeError.toLowerCase()} failed.`);
    return result;
  }

  async initialize(options: EngineOptions): Promise<EngineStartup> {
    if (this.startup) return this.startup;
    const begin = performance.now();
    const searchMemory = resolveSearchMemory(options.searchMemory);
    const wasmMemory = resolveWasmMemory(options.wasmMemory, this.defaultWasmMemory);
    const timeoutMs = options.timeoutMs ?? 10000;
    const retries = options.retries ?? 2;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(retries) || retries < 0 || retries > 5)
      throw new RoutingError('INVALID_REQUEST', 'Invalid timeout or retry limit.');
    const manifestUrl = options.manifestUrl;
    const metadata = { requests: 0, bytes: 0 };
    this.manifest = JSON.parse(new TextDecoder().decode(await documentBytes(manifestUrl, timeoutMs, retries, metadata, this.store, this.signal)));
    if (!Array.isArray(this.manifest.coverage) || this.manifest.coverage.length !== 4 || !this.manifest.coverage.every(Number.isFinite))
      throw new RoutingError('DATASET', 'Missing coverage bounds.');
    this.loader = new TileLoader(this.manifest, manifestUrl, { ...options, onProgress: this.progress, store: this.store });
    this.loader.signal = this.signal;
    const configBytes = await documentBytes(new URL(this.manifest.config.url, manifestUrl), timeoutMs, retries, metadata, this.store, this.signal);
    if (await sha256(configBytes) !== this.manifest.config.sha256) throw new RoutingError('DATASET_MISMATCH', 'Configuration hash mismatch.');
    this.config = JSON.parse(new TextDecoder().decode(configBytes));
    this.config.mjolnir.tile_url = this.loader.transport === 'indexed-tar' ? this.loader.archiveUrl : new URL('tiles/{tilePath}', manifestUrl).href.replace('%7BtilePath%7D', '{tilePath}');
    const budget = options.memoryBudgetBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(budget) || budget < 1024 || budget > 128 * 1024 * 1024) throw new RoutingError('INVALID_REQUEST', 'Memory budget must be between 1 KiB and 128 MiB.');
    // The upstream hard LRU throws for an oversized single tile. Loki can swallow
    // that exception as a failed correlation, so reject the configuration explicitly.
    if ([...this.loader.byRange.values()].some(tile => tile.size > BigInt(budget)))
      throw new RoutingError('INVALID_REQUEST', 'Memory budget must fit the largest individual tile in this dataset.');
    this.config.mjolnir.max_cache_size = budget;
    this.config.mjolnir.use_lru_mem_cache = true;
    this.config.mjolnir.lru_mem_cache_hard_control = true;
    this.config.mjolnir.global_synchronized_cache = false;
    // Reserve modest reusable search storage without capping native expansions.
    // Keep source metadata immutable; record the effective configuration separately.
    this.config.thor = { ...this.config.thor,
      max_reserved_labels_count_astar: searchMemory.astar,
      max_reserved_labels_count_bidir_astar: searchMemory.bidirectionalAstar,
      clear_reserved_memory: searchMemory.clearReservedMemory };
    this.effectiveConfigSha256 = await sha256(new Uint8Array(new TextEncoder().encode(JSON.stringify(this.config))));
    const metadataMs = performance.now() - begin;
    this.progress({ phase: 'loading-runtime' });
    const moduleStart = performance.now();
    this.module ??= await this.createModule(createWasmMemory(wasmMemory), wasmMemory.maximumMiB * 1048576);
    const build = await this.call<NativeStats>('vb_stats');
    if (build.sourceRevision !== this.manifest.valhallaRevision || build.valhallaVersion !== this.manifest.valhallaVersion || build.abi !== this.expectedAbi)
      throw new RoutingError('INCOMPATIBLE_RUNTIME', 'The loaded WASM module does not match the dataset or SDK.');
    this.module.tileLoader = this.loader;
    this.module.interrupt = this.interrupt;
    const moduleStartupMs = performance.now() - moduleStart;
    const graphStart = performance.now();
    await this.call('vb_init', this.config);
    this.initialized = true;
    return this.startup = { release: this.manifest.release, supportedCostings: SUPPORTED_COSTINGS.filter(costing => this.manifest.costings.includes(costing)), configSha256: this.manifest.config.sha256, effectiveConfigSha256: this.effectiveConfigSha256, searchMemory, moduleStartupMs,
      graphStartupMs: metadataMs + performance.now() - graphStart, loader: { ...this.loader.metrics },
      graphStartupRequests: metadata.requests + this.loader.metrics.requests, graphStartupBytes: metadata.bytes + this.loader.metrics.bytes,
      native: await this.call<NativeStats>('vb_stats'), memoryBudgetBytes: budget, wasmMemory };
  }

  async route(request: NormalizedRequest): Promise<EngineRoute> {
    if (!this.initialized) throw new RoutingError('NOT_INITIALIZED', 'Initialize the router first.');
    request = validateRequest(request);
    if (!this.manifest.costings.includes(request.costing))
      throw new RoutingError('UNSUPPORTED_COSTING', `Dataset ${this.manifest.release} does not support ${request.costing}. Available profiles: ${SUPPORTED_COSTINGS.filter(costing => this.manifest.costings.includes(costing)).join(', ')}.`);
    const [west, south, east, north] = this.manifest.coverage;
    if (request.locations.some(p => p.lon < west || p.lon > east || p.lat < south || p.lat > north))
      throw new RoutingError('OUTSIDE_COVERAGE', 'A location is outside this dataset’s coverage.');
    const start = performance.now();
    const before = { ...this.loader.metrics };
    const nativeBefore = await this.call<NativeStats>('vb_stats');
    this.progress({ phase: 'routing' });
    const native = await this.call<NativeRoute>('vb_route', request);
    const diagnostics = { decodedCacheHits: 0, routeMs: performance.now() - start, native: await this.call<NativeStats>('vb_stats'),
      loader: Object.fromEntries(Object.entries(this.loader.metrics).map(([key, value]) => [key, value - before[key as keyof LoaderMetrics]])) as unknown as LoaderMetrics };
    diagnostics.decodedCacheHits = diagnostics.native.decodedCacheHits - nativeBefore.decodedCacheHits;
    return { native, dataset: { release: this.manifest.release, valhallaRevision: this.manifest.valhallaRevision, configSha256: this.manifest.config.sha256, effectiveConfigSha256: this.effectiveConfigSha256 }, diagnostics };
  }

  async diagnostics(): Promise<EngineDiagnostics> {
    if (!this.initialized) throw new RoutingError('NOT_INITIALIZED', 'Initialize the router first.');
    return { metrics: { ...this.loader.metrics }, trace: [...this.loader.trace], native: await this.call<NativeStats>('vb_stats') };
  }
  async dispose(): Promise<void> {
    this.setOperation();
    if (this.module) { await this.call('vb_dispose'); this.module.tileLoader = undefined; }
    this.initialized = false; this.startup = undefined;
  }
}
