import type { Costing, WasmMemoryOptions, EffectiveWasmMemory, EffectiveSearchMemory, LoaderMetrics, NativeStats, NativeRoute, ProgressEvent, RouteResult as BrowserRouteResult, SearchMemoryOptions, TileTrace, TileTransport } from '@tobilg/valhalla-core/types';
export type { Coordinates, Costing, CostingOptions, BicycleCostingOptions, PedestrianCostingOptions, TruckCostingOptions, RouteProfile, RouteRequest, WasmMemoryOptions, EffectiveWasmMemory, SearchMemoryOptions, EffectiveSearchMemory, NativeRoute, NativeStats, TileTransport, ProgressEvent } from '@tobilg/valhalla-core/types';

/** Loader counters with unavailable Cloudflare timing represented explicitly. */
export interface ServerLoaderMetrics extends Omit<LoaderMetrics, 'sequentialWaitMs'> {
  /** Time waiting for graph reads; null in Cloudflare. */
  sequentialWaitMs: number | null;
}
/** Successful graph read with optional wall-clock timing. */
export interface ServerTileTrace extends Omit<TileTrace, 'elapsedMs'> {
  /** Read wall time; null in Cloudflare. */
  elapsedMs: number | null;
}

/** Shared server configuration. One native operation executes at a time. */
export interface ServerOptions {
  /** Tile backend; defaults to indexed-tar. */
  transport?: TileTransport;
  /** Decoded-tile cache budget in bytes; default 32 MiB, not a total-memory limit. */
  memoryBudgetBytes?: number;
  /** Native label reservations; default 16,384 per A* vector. */
  searchMemory?: SearchMemoryOptions;
  /** Per-instance linear memory: defaults to 256 MiB initial / 512 MiB maximum in Node or 64 MiB initial / 96 MiB maximum in Cloudflare. Changes require a new instance. */
  wasmMemory?: WasmMemoryOptions;
  /** Per-fetch deadline in milliseconds; default 10,000. */
  timeoutMs?: number;
  /** Additional transient-fetch attempts; default two. */
  retries?: number;
  /** Waiting operations beyond the active call; 0–1024, default eight. */
  maxQueuedRoutes?: number;
  /** Maximum queue wait in milliseconds; 1–60,000, default 2,000. */
  queueTimeoutMs?: number;
  /** Overall operation deadline including queue/startup; 1–300,000 ms, default 30,000. */
  routeTimeoutMs?: number;
  /** Receives operation progress. Callback exceptions are ignored. */
  onProgress?: (event: ProgressEvent) => void;
}
/** Per-call cancellation. Aborting queued work leaves other callers intact. */
export interface OperationOptions {
  /** Caller cancellation signal. */
  signal?: AbortSignal;
}
/** Initialization identity and measurements. Cloudflare timings are unavailable, not zero. */
export interface StartupResult {
  /** Immutable dataset release. */
  release: string;
  /** Profiles supported by this runtime and dataset. */
  supportedCostings: readonly Costing[];
  /** Source config SHA-256. */
  configSha256: string;
  /** Effective native config SHA-256, including runtime overrides. */
  effectiveConfigSha256: string;
  /** WASM startup milliseconds; null in Cloudflare. */
  moduleStartupMs: number | null;
  /** Graph startup milliseconds; null in Cloudflare. */
  graphStartupMs: number | null;
  /** Host readiness milliseconds; null in Cloudflare. */
  runtimeReadyMs: number | null;
  /** Startup metadata/tile-loader read attempts. */
  graphStartupRequests: number;
  /** Validated startup bytes. */
  graphStartupBytes: number;
  /** Retained-tile budget. */
  memoryBudgetBytes: number;
  /** Resolved native label policy. */
  searchMemory: EffectiveSearchMemory;
  /** Resolved initial allocation and hard WASM growth ceiling. */
  wasmMemory: EffectiveWasmMemory;
  /** Loader counters at initialization. */
  loader: ServerLoaderMetrics;
  /** Native identity and memory counters. */
  native: NativeStats;
}
/** Real native route with server diagnostics. */
export interface RouteResult {
  /** Complete native response. */
  native: NativeRoute;
  /** Immutable graph and source/effective config identity. */
  dataset: BrowserRouteResult['dataset'];
  /** Per-route diagnostics. */
  diagnostics: {
    /** Native-call wall time including tile waits; null in Cloudflare. */
    routeMs: number | null;
    /** Total host wall time including queue and startup; null in Cloudflare. */
    hostRouteMs: number | null;
    /** Time waiting for admission; null in Cloudflare. */
    queueWaitMs: number | null;
    /** Number of native decoded-cache hits. */
    decodedCacheHits: number;
    /** Route-specific loader counters. */
    loader: ServerLoaderMetrics;
    /** Native state after routing. */
    native: NativeStats;
  };
}
/** Server diagnostics; browser resource timings do not exist in these hosts. */
export interface Diagnostics {
  /** Native cooperative checkpoints observed; zero for Node, which terminates its thread. */
  cooperativeCheckpoints: number;
  /** Cumulative loader counters. */
  metrics: ServerLoaderMetrics;
  /** Successful read traces. R2 entries carry no HTTP cache headers. */
  trace: ServerTileTrace[];
  /** Native state. */
  native: NativeStats;
  /** Browser Resource Timing is unavailable. */
  resourceTiming: null;
}
