import createModule from '../../../public/wasm/valhalla-browser.js';
import { TileLoader, sha256, readMetadata } from './loader.js';
import { RoutingError, asError } from './errors.js';
import type { DatasetManifest, NativeConfig } from './dataset.js';
import type { NormalizedRequest, Operations, WorkerOptions, WorkerRequest, WorkerResponse } from './protocol.js';
import type { Diagnostics, LoaderMetrics, NativeRoute, NativeStats, ProgressDetail } from './types.js';

let module: Awaited<ReturnType<typeof createModule>>;
let loader: TileLoader;
let manifest: DatasetManifest;
let config: NativeConfig;
let initialized = false;
const scope = self as DedicatedWorkerGlobalScope;
const respond = (message: WorkerResponse) => scope.postMessage(message);
let queue = Promise.resolve();
let currentId: number;
const progress = (detail: ProgressDetail) => respond({ type: 'progress', id: currentId, detail });

async function documentBytes(url: string | URL, timeoutMs: number, retries: number, metrics: { requests: number; bytes: number }): Promise<Uint8Array<ArrayBuffer>> {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      metrics.requests++;
      const response = await fetch(url, { credentials: 'omit', signal });
      if (!response.ok) { await response.body?.cancel(); throw new RoutingError([401, 403].includes(response.status) ? 'ACCESS_DENIED' : 'NETWORK', `Metadata HTTP ${response.status}.`, { retryable: response.status >= 500 || response.status === 429 }); }
      const bytes = await readMetadata(response, signal);
      metrics.bytes += bytes.length;
      return bytes;
    } catch (error) {
      const typed = signal.aborted ? new RoutingError('TIMEOUT', 'Metadata request timed out.', { retryable: true }) :
        error instanceof RoutingError ? error : new RoutingError('NETWORK', 'Metadata download failed.', { retryable: true });
      if (!typed.retryable || attempt >= retries) throw typed;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

async function call<T>(name: string, input?: unknown): Promise<T> {
  module.bridgeError = undefined;
  const raw = await module.ccall(name, 'string', input === undefined ? [] : ['string'], input === undefined ? [] : [JSON.stringify(input)], { async: true });
  if (module.bridgeError) throw module.bridgeError;
  const result = JSON.parse(raw) as T & { nativeError?: number; runtimeError?: string };
  if (result.nativeError !== undefined) {
    const code = result.nativeError;
    throw new RoutingError(code === 442 ? 'NO_ROUTE' : code === 171 ? 'LOCATION_NOT_FOUND' : 'NATIVE', `Valhalla error ${code}.`, { nativeCode: code });
  }
  if (result.runtimeError) throw new RoutingError('RUNTIME', `Valhalla ${result.runtimeError.toLowerCase()} failed.`);
  return result;
}

async function initialize(options: WorkerOptions): Promise<Operations['initialize']['result']> {
  const begin = performance.now();
  const timeoutMs = options.timeoutMs ?? 10000;
  const retries = options.retries ?? 2;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isInteger(retries) || retries < 0 || retries > 5)
    throw new RoutingError('INVALID_REQUEST', 'Invalid timeout or retry limit.');
  const manifestUrl = options.manifestUrl;
  const metadata = { requests: 0, bytes: 0 };
  manifest = JSON.parse(new TextDecoder().decode(await documentBytes(manifestUrl, timeoutMs, retries, metadata)));
  if (!Array.isArray(manifest.coverage) || manifest.coverage.length !== 4 || !manifest.coverage.every(Number.isFinite))
    throw new RoutingError('DATASET', 'Missing coverage bounds.');
  loader = new TileLoader(manifest, manifestUrl, { ...options, onProgress: progress });
  const configBytes = await documentBytes(new URL(manifest.config.url, manifestUrl), timeoutMs, retries, metadata);
  if (await sha256(configBytes) !== manifest.config.sha256) throw new RoutingError('DATASET_MISMATCH', 'Configuration hash mismatch.');
  config = JSON.parse(new TextDecoder().decode(configBytes));
  config.mjolnir.tile_url = loader.transport === 'indexed-tar' ? loader.archiveUrl : new URL('tiles/{tilePath}', manifestUrl).href.replace('%7BtilePath%7D', '{tilePath}');
  const budget = options.memoryBudgetBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(budget) || budget < 1024 || budget > 128 * 1024 * 1024) throw new RoutingError('INVALID_REQUEST', 'Memory budget must be between 1 KiB and 128 MiB.');
  config.mjolnir.max_cache_size = budget;
  config.mjolnir.use_lru_mem_cache = true;
  config.mjolnir.lru_mem_cache_hard_control = true;
  config.mjolnir.global_synchronized_cache = false;
  const metadataMs = performance.now() - begin;
  progress({ phase: 'loading-runtime' });
  const moduleStart = performance.now();
  module ??= await createModule({ locateFile: () => options.wasmUrl, print: () => {}, printErr: console.error });
  const build = await call<NativeStats>('vb_stats');
  if (build.sourceRevision !== manifest.valhallaRevision || build.valhallaVersion !== manifest.valhallaVersion || build.abi !== 1)
    throw new RoutingError('INCOMPATIBLE_RUNTIME', 'The loaded WASM module does not match the dataset or SDK.');
  module.tileLoader = loader;
  const moduleStartupMs = performance.now() - moduleStart;
  const graphStart = performance.now();
  await call('vb_init', config);
  initialized = true;
  return { release: manifest.release, configSha256: manifest.config.sha256, moduleStartupMs,
    graphStartupMs: metadataMs + performance.now() - graphStart, loader: { ...loader.metrics },
    graphStartupRequests: metadata.requests + loader.metrics.requests, graphStartupBytes: metadata.bytes + loader.metrics.bytes,
    native: await call<NativeStats>('vb_stats'), memoryBudgetBytes: budget };
}

async function route(request: NormalizedRequest): Promise<Operations['route']['result']> {
  if (!initialized) throw new RoutingError('NOT_INITIALIZED', 'Initialize the router first.');
  const [west, south, east, north] = manifest.coverage;
  if (request.locations.some(p => p.lon < west || p.lon > east || p.lat < south || p.lat > north))
    throw new RoutingError('OUTSIDE_COVERAGE', 'A location is outside this dataset’s coverage.');
  const start = performance.now();
  const before = { ...loader.metrics };
  const nativeBefore = await call<NativeStats>('vb_stats');
  progress({ phase: 'routing' });
  const native = await call<NativeRoute>('vb_route', request);
  const diagnostics = { decodedCacheHits: 0, routeMs: performance.now() - start, native: await call<NativeStats>('vb_stats'),
    loader: Object.fromEntries(Object.entries(loader.metrics).map(([key, value]) => [key, value - before[key as keyof LoaderMetrics]])) as unknown as LoaderMetrics };
  diagnostics.decodedCacheHits = diagnostics.native.decodedCacheHits - nativeBefore.decodedCacheHits;
  return { native, dataset: { release: manifest.release, valhallaRevision: manifest.valhallaRevision, configSha256: manifest.config.sha256 }, diagnostics };
}

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  // No actor entry occurs outside this chain, including constructor and destruction.
  queue = queue.then(async () => {
    currentId = data.id;
    try {
      let result: Operations[keyof Operations]['result'];
      switch (data.type) {
        case 'initialize': result = await initialize(data.options); break;
        case 'route': result = await route(data.request); break;
        case 'diagnostics': {
          if (!initialized) throw new RoutingError('NOT_INITIALIZED', 'Initialize the router first.');
          const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          result = { metrics: loader.metrics, trace: loader.trace, native: await call<NativeStats>('vb_stats'),
            resourceTiming: entries.map(e => ({ name: e.name, durationMs: e.duration, transferSize: e.transferSize ?? null,
              encodedBodySize: e.encodedBodySize ?? null, decodedBodySize: e.decodedBodySize ?? null })) } satisfies Diagnostics;
          break;
        }
        default: throw new RoutingError('INVALID_REQUEST', 'Unknown worker operation.');
      }
      respond({ id: data.id, type: 'result', result });
    } catch (error) {
      respond({ id: data.id, type: 'error', error: asError(error).toJSON() });
    }
  });
};
respond({ type: 'ready' });
