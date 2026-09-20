import type { TileTransport, SearchMemoryOptions, WasmMemoryOptions, ProgressEvent } from '@tobilg/valhalla-core/types';
export type * from '@tobilg/valhalla-core/types';

/** Session configuration for a compatible, immutable dataset. */
export interface RouterOptions {
  /** Versioned manifest URL. Relative URLs resolve against the page; the parent directory must match its release ID. */
  manifestUrl: string;
  /** Tile delivery backend. Defaults to `indexed-tar`. */
  transport?: TileTransport;
  /** Retained decoded-tile cache budget in bytes: 1 KiB–128 MiB, default 32 MiB. Must fit the dataset's largest tile. This is not a total-worker memory limit. */
  memoryBudgetBytes?: number;
  /** Search-label reservations and cleanup policy. Omitted fields use SDK defaults, independently of the decoded-tile cache budget. Changes take effect on the next initialization. */
  searchMemory?: SearchMemoryOptions;
  /** Per-worker linear memory: default 128 MiB initial, 512 MiB maximum. Changes apply to the next worker instance. */
  wasmMemory?: WasmMemoryOptions;
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
