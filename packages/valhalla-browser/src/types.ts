/** Latitude/longitude in decimal degrees (WGS84). */
export interface Coordinates {
  /** Latitude in the inclusive range -90 to 90. */
  lat: number;
  /** Longitude in the inclusive range -180 to 180. */
  lon: number;
}
/** Validated road travel profiles. Transit and combined journeys are not supported. */
export type Costing = 'auto' | 'bicycle' | 'pedestrian' | 'truck';
/** Bicycle settings; omitted values use the pinned Valhalla defaults. */
export interface BicycleCostingOptions {
  /** Bicycle type; defaults to hybrid. Type also determines the default cycling speed. */
  bicycle_type?: 'road' | 'cross' | 'hybrid' | 'mountain';
  /** Speed on smooth flat roads in km/h, 5–60. Defaults: road 25, cross 20, hybrid 18, mountain 16. */
  cycling_speed?: number;
  /** Road preference, 0–1; 0 prefers avoiding roads, 1 prefers roads. Default 0.25. */
  use_roads?: number;
}
/** Walking settings for the native foot profile. */
export interface PedestrianCostingOptions {
  /** Walking speed in km/h, 0.5–25; default 5.1. */
  walking_speed?: number;
}
/** Truck attributes used with restrictions recorded in the graph. Omitted values use native defaults. */
export interface TruckCostingOptions {
  /** Height in meters, 0–10; default 4.11. */
  height?: number;
  /** Width in meters, 0–10; default 2.6. */
  width?: number;
  /** Length in meters, 0–50; default 21.64. */
  length?: number;
  /** Total vehicle weight in metric tonnes, 0–100; default 21.77. */
  weight?: number;
  /** Axle load in metric tonnes, 0–40; default 9.07. */
  axle_load?: number;
  /** Whether hazardous goods are carried; default false. */
  hazmat?: boolean;
}
/** Native option groups. A route accepts only the group matching its selected profile. */
export interface CostingOptions {
  /** Settings for cycling. */
  bicycle?: BicycleCostingOptions;
  /** Settings for walking. */
  pedestrian?: PedestrianCostingOptions;
  /** Vehicle attributes for truck routing. */
  truck?: TruckCostingOptions;
}
/** Profile selection with its matching native option group. */
export type RouteProfile =
  | {
      /** Driving is the default when omitted. */
      costing?: 'auto';
      /** Driving tuning is not exposed. */
      costing_options?: never;
    }
  | {
      /** Cycling profile. */
      costing: 'bicycle';
      /** Only bicycle options are accepted. */
      costing_options?: {
        /** Bicycle settings for this route. */
        bicycle: BicycleCostingOptions;
        /** Walking settings cannot be used for cycling. */
        pedestrian?: never;
        /** Truck settings cannot be used for cycling. */
        truck?: never;
      };
    }
  | {
      /** Walking profile. */
      costing: 'pedestrian';
      /** Only pedestrian options are accepted. */
      costing_options?: {
        /** Walking settings for this route. */
        pedestrian: PedestrianCostingOptions;
        /** Bicycle settings cannot be used for walking. */
        bicycle?: never;
        /** Truck settings cannot be used for walking. */
        truck?: never;
      };
    }
  | {
      /** Truck profile. */
      costing: 'truck';
      /** Only truck options are accepted. */
      costing_options?: {
        /** Vehicle attributes for this route. */
        truck: TruckCostingOptions;
        /** Bicycle settings cannot be used for truck routing. */
        bicycle?: never;
        /** Walking settings cannot be used for truck routing. */
        pedestrian?: never;
      };
    };
/**
 * Exactly two locations with a supported road profile and optional matching settings.
 * @remarks Supply either origin/destination or an ordered locations tuple.
 * The SDK fixes kilometers, English instructions, a 30 m correlation radius,
 * and minimum reachability 0. Additional native request options are not exposed.
 */
export type RouteRequest = RouteProfile & (
  | {
      /** Start coordinate inside the dataset coverage. */
      origin: Coordinates;
      /** End coordinate inside the dataset coverage. */
      destination: Coordinates;
    }
  | {
      /** Ordered pair: start, then end. Intermediate stops are unsupported. */
      locations: [Coordinates, Coordinates];
    });
/** Delivery method for the same standard Valhalla graph tiles. */
export type TileTransport = 'indexed-tar' | 'individual-tiles';
/** Current stage of worker initialization or routing. Events are informational, not a percentage. */
export type ProgressPhase = 'loading-runtime' | 'initializing-graph' | 'fetching-tile' | 'routing';
/** Progress notification from the active worker operation. */
export interface ProgressDetail {
  /** Current initialization, computation or download stage. */
  phase: ProgressPhase;
  /** Decimal GraphId when the event concerns a tile; absent for other events. */
  tileId?: string;
}
/** Host progress notification associated with a request ID. */
export interface ProgressEvent extends ProgressDetail {
  /** Monotonically increasing operation ID within this Router. */
  requestId: number;
}

/** Session configuration for a compatible, immutable dataset. */
export interface RouterOptions {
  /** Versioned manifest URL. Relative URLs resolve against the page; the parent directory must match its release ID. */
  manifestUrl: string;
  /** Tile delivery backend. Defaults to `indexed-tar`. */
  transport?: TileTransport;
  /** Retained decoded-tile cache budget in bytes: 1 KiB–128 MiB, default 32 MiB. Must fit the dataset's largest tile. This is not a total-worker memory limit. */
  memoryBudgetBytes?: number;
  /** Fetch/worker-load deadline per attempt in integer ms, 1–60,000; default 10,000. WASM startup receives at least 10 seconds. */
  timeoutMs?: number;
  /** Additional attempts for transient fetch failures, integer 0–5; defaults to 2. Zero also disables the single shared startup retry for opaque worker-load failures or WASM initialization timeouts. */
  retries?: number;
  /** Receives worker progress on the main thread. Callback exceptions are ignored; avoid blocking UI work. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional matching module worker. Relative URLs resolve against the page; cross-origin URLs need CORS and blob-worker CSP permission. */
  workerUrl?: string | URL;
  /** Optional matching WASM binary. Relative URLs resolve against the page. Defaults to the package's bundled binary. */
  wasmUrl?: string | URL;
  /** Takes precedence over workerUrl. Each call must return a fresh worker implementing this SDK version's protocol. Disables automatic worker-startup retries. Advanced integration only. */
  workerFactory?: () => Worker;
}

/**
 * Fetch attempts and validated bytes; these are not necessarily origin network transfers.
 * Route results contain per-route deltas; session diagnostics contain cumulative values.
 */
export interface LoaderMetrics {
  /** Tile-loader Fetch API attempts, including retries and archive index/header reads. Excludes manifest/config fetches. */
  requests: number;
  /** Successfully downloaded complete tiles; evicted tiles can be downloaded again. */
  tileDownloads: number;
  /** Validated response-body bytes consumed by the tile loader, including its metadata reads. */
  bytes: number;
  /** Portion of bytes used by the native archive header/index, excluding JSON metadata. */
  metadataBytes: number;
  /** Accumulated download time in ms, including body reads, retries/backoff and integrity validation. */
  sequentialWaitMs: number;
  /** Requests sharing an already in-flight download. */
  deduplicated: number;
  /** Additional fetch attempts after transient failures. */
  retries: number;
}
/** Native build identity and cumulative memory/cache counters for this worker. */
export interface NativeStats {
  /** Bytes retained in the native decoded-tile cache; excludes live references outside that cache. */
  decodedCacheBytes: number;
  /** Cumulative native tile-cache lookup hits. */
  decodedCacheHits: number;
  /** Allocated linear-memory capacity high-water in bytes, not live allocations or process RSS. */
  wasmHeapCapacityHighWaterBytes: number;
  /** Valhalla release compiled into the worker's WASM. */
  valhallaVersion: string;
  /** Upstream Git revision compiled into WASM; must match the dataset. */
  sourceRevision: string;
  /** SDK/native bridge ABI version. */
  abi: number;
}
/** Module and graph initialization measurements; times are milliseconds. */
export interface StartupResult {
  /** Profiles supported by both this SDK and the dataset manifest. Old auto-only datasets remain driving-only. */
  supportedCostings: readonly Costing[];
  /** Immutable dataset release ID. */
  release: string;
  /** SHA-256 of the validated runtime configuration bytes. */
  configSha256: string;
  /** WASM loading/compilation/instantiation time inside the worker. */
  moduleStartupMs: number;
  /** JSON metadata download/validation plus native graph-reader initialization time. */
  graphStartupMs: number;
  /** Main-thread elapsed time until the worker and graph are ready, including worker loading. */
  workerReadyMs: number;
  /** Fetch attempts during startup, including manifest/config and loader metadata attempts. */
  graphStartupRequests: number;
  /** Validated startup body bytes, including manifest/config and loader metadata. */
  graphStartupBytes: number;
  /** Effective retained decoded-tile cache budget in bytes. */
  memoryBudgetBytes: number;
  /** Loader counters sampled at startup completion. */
  loader: LoaderMetrics;
  /** Native identity and memory counters sampled at startup completion. */
  native: NativeStats;
}
/** Full Valhalla JSON with typed common fields and preserved additional native fields. */
export interface NativeRoute {
  /** Successful native trip response, including its ordered legs. */
  trip: {
    /** Totals across the trip. */
    summary: {
      /** Total distance in kilometers. */
      length: number;
      /** Estimated travel time in seconds. */
      time: number;
      [key: string]: unknown;
    };
    /** Native route legs, in travel order. */
    legs: Array<{
      /** Encoded polyline using six decimal places (polyline6). */
      shape: string;
      /** Ordered turn instructions for this leg. */
      maneuvers: Array<{
        /** English maneuver instruction. */
        instruction: string;
        /** Native Valhalla maneuver type number. */
        type: number;
        /** Maneuver distance in kilometers. */
        length: number;
        /** Maneuver travel time in seconds. */
        time: number;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
/** Native response, immutable dataset identity and per-route diagnostics. */
export interface RouteResult {
  /** Complete native response: kilometers, seconds, and polyline6 shapes. */
  native: NativeRoute;
  /** Identifies the graph and configuration used to calculate this response. */
  dataset: {
    /** Immutable release directory name. */
    release: string;
    /** Upstream Valhalla Git revision for these tiles. */
    valhallaRevision: string;
    /** SHA-256 of the dataset's runtime configuration. */
    configSha256: string;
  };
  /** Measurements for this operation; nested native counters remain cumulative. */
  diagnostics: {
    /** Worker-observed native route call time in ms, including Asyncify fetch waits. */
    routeMs: number;
    /** Main-thread route-call time in ms, including any lazy startup and queue wait. */
    hostRouteMs: number;
    /** Native decoded-cache hits during this route only. */
    decodedCacheHits: number;
    /** Loader counter deltas during this route. */
    loader: LoaderMetrics;
    /** Cumulative native state after the route. */
    native: NativeStats;
  };
}
/** A validated tile/metadata fetch; 64-bit offsets and lengths remain decimal strings. */
export interface TileTrace {
  /** Actual requested object URL; avoid logging traces by default. */
  url: string;
  /** Requested byte offset in the object, as an exact decimal string. */
  offset: string;
  /** Requested byte count, as an exact decimal string. */
  size: string;
  /** Decimal GraphId for tile reads, absent for archive metadata. */
  tileId?: string;
  /** Download elapsed time in ms, including retries/backoff and integrity validation. */
  elapsedMs: number;
  /** Selected response headers; inaccessible or missing values are null. Cache headers may be replayed from browser cache. */
  http: Record<string, string | null>;
}
/** Cumulative loader, cache and memory data for the current worker. */
export interface Diagnostics {
  /** Cumulative counters since this worker's loader was created. */
  metrics: LoaderMetrics;
  /** Most recent 2,048 successful validated fetch traces, including tile URLs and IDs. No telemetry is sent automatically. */
  trace: TileTrace[];
  /** Current native build identity and cumulative memory/cache counters. */
  native: NativeStats;
  /** Browser resource timings as exposed inside the worker. Cross-origin zeros without Timing-Allow-Origin do not prove cache hits. */
  resourceTiming: Array<{
    /** Requested resource URL. */
    name: string;
    /** Browser-observed resource duration in milliseconds. */
    durationMs: number;
    /** Browser transfer-size field in bytes, or null when unavailable. Zero can mean either caching or restricted visibility. */
    transferSize: number | null;
    /** Encoded response-body size in bytes, or null when unavailable. Cross-origin restrictions can produce zero. */
    encodedBodySize: number | null;
    /** Decoded response-body size in bytes, or null when unavailable. Cross-origin restrictions can produce zero. */
    decodedBodySize: number | null;
  }>;
}
