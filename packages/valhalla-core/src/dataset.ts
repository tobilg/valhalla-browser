export interface TileEntry {
  path: string;
  offset: string;
  size: string;
  sha256: string;
  etag?: string;
}
export interface DatasetManifest {
  schema: number;
  release: string;
  valhallaRevision: string;
  valhallaVersion: string;
  costings: string[];
  coverage: [number, number, number, number];
  config: { url: string; sha256: string };
  archive: { url: string; size: string; indexSize: string; etag: string; headerSha256: string; indexSha256: string };
  tiles: Record<string, TileEntry>;
}
export interface NativeConfig {
  thor?: Record<string, unknown>;
  mjolnir: {
    tile_url: string;
    max_cache_size: number;
    use_lru_mem_cache: boolean;
    lru_mem_cache_hard_control: boolean;
    global_synchronized_cache: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
