import { RoutingError, type RoutingErrorCode } from './errors.js';
import type { DatasetManifest, TileEntry } from './dataset.js';
import type { LoaderMetrics, ProgressDetail, TileTrace, TileTransport } from './types.js';
import { SUPPORTED_COSTINGS } from './profiles.js';

interface LoaderOptions { transport?: TileTransport; timeoutMs?: number; retries?: number; onProgress?: (event: ProgressDetail) => void }
interface Tile extends Omit<TileEntry, 'offset' | 'size'> { id: string; offset: bigint; size: bigint; url: string; etag: string }

export const RUNTIME_REVISION = 'a60c7cbfc83e073f50887cd27e0109d02e6b64e5';
const LIMIT = 64 * 1024 * 1024;
// HTTP validators are opaque (S3 may use MD5 or multipart ETags). Integrity
// remains a separate SHA-256 check on every fetched tile/header/index.
const strongValidator = (value: unknown) => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,256}"$/.test(value);
const fail = (code: RoutingErrorCode, message: string, retryable = false) => new RoutingError(code, message, { retryable });
export const sha256 = async (bytes: BufferSource): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

export function integer(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw fail('DATASET', `Invalid ${name}.`);
  const n = BigInt(value);
  if (n > 0xffffffffffffffffn) throw fail('DATASET', `${name} exceeds uint64.`);
  return n;
}

export async function readBounded(response: Response, expected: number, signal?: AbortSignal, { exact = true } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw fail('DATASET', 'Response has no body.');
  const bytes = new Uint8Array(expected);
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > expected) throw fail('DATASET', 'Response exceeds expected size.');
      bytes.set(value, length);
      length += value.length;
    }
    if (exact && length !== expected) throw fail('DATASET', 'Truncated response.');
    return length === expected ? bytes : bytes.slice(0, length);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Fetch exposes decoded JSON bytes, while Content-Length describes the encoded
// body (and can be absent on a CDN). Bound decoded metadata independently.
export async function readMetadata(response: Response, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const limit = 4 * 1024 * 1024;
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw fail('DATASET', 'Invalid metadata length.');
  }
  const encoding = response.headers.get('Content-Encoding');
  const exact = length !== null && (!encoding || encoding === 'identity');
  return readBounded(response, exact ? Number(length) : limit, signal, { exact });
}

export class TileLoader {
  readonly manifest: DatasetManifest;
  readonly transport: TileTransport;
  readonly timeoutMs: number;
  retries: number;
  readonly onProgress?: (event: ProgressDetail) => void;
  readonly archiveUrl: string;
  readonly archiveSize: bigint;
  readonly indexSize: bigint;
  readonly byRange = new Map<string, Tile>();
  readonly byUrl = new Map<string, Tile>();
  readonly inflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  readonly controllers = new Set<AbortController>();
  readonly metrics: LoaderMetrics;
  readonly trace: TileTrace[];
  constructor(manifest: DatasetManifest, manifestUrl: string, { transport = 'indexed-tar', timeoutMs = 10000, retries = 2, onProgress }: LoaderOptions = {}) {
    if (!['indexed-tar', 'individual-tiles'].includes(transport)) throw fail('INVALID_REQUEST', 'Unsupported tile transport.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isInteger(retries) || retries < 0 || retries > 5) throw fail('INVALID_REQUEST', 'Invalid fetch limits.');
    if (manifest.schema !== 1 || manifest.valhallaRevision !== RUNTIME_REVISION || manifest.valhallaVersion !== '3.8.3')
      throw fail('INCOMPATIBLE_DATASET', 'Dataset does not match this runtime.');
    if (!Array.isArray(manifest.costings) || !manifest.costings.length ||
        manifest.costings.some(costing => typeof costing !== 'string' || !costing.length) ||
        new Set(manifest.costings).size !== manifest.costings.length) throw fail('DATASET', 'Invalid dataset costing list.');
    if (!SUPPORTED_COSTINGS.some(costing => manifest.costings.includes(costing)))
      throw fail('INCOMPATIBLE_DATASET', 'Dataset has no profiles supported by this SDK.');
    if (typeof manifest.release !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(manifest.release) ||
        new URL('.', manifestUrl).pathname.split('/').at(-2) !== manifest.release)
      throw fail('DATASET', 'Dataset URL parent directory must match its release.');
    this.manifest = manifest;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.onProgress = onProgress;
    this.archiveUrl = new URL(manifest.archive.url, manifestUrl).href;
    this.archiveSize = integer(manifest.archive.size, 'archive size');
    this.indexSize = integer(manifest.archive.indexSize, 'index size');
    if (!this.indexSize || this.indexSize % 16n || this.indexSize > BigInt(LIMIT)) throw fail('DATASET', 'Invalid native index size.');
    if (!strongValidator(manifest.archive.etag)) throw fail('DATASET', 'A strong archive validator is required.');
    for (const [id, entry] of Object.entries(manifest.tiles)) {
      const tileId = integer(id, 'tile ID');
      const offset = integer(entry.offset, 'tile offset');
      const size = integer(entry.size, 'tile size');
      if (tileId >= (1n << 25n) || (tileId & 7n) > 2n || size < 272n || size > BigInt(LIMIT) ||
          offset < 512n + this.indexSize || offset % 512n || offset + size > this.archiveSize ||
          !/^[012]\/(?:\d{3}\/)*\d{3}\.gph$/.test(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw fail('DATASET', 'Invalid tile entry.');
      const url = new URL(`tiles/${entry.path}`, manifestUrl).href;
      const tile: Tile = { ...entry, id, offset, size, url, etag: entry.etag ?? `"${entry.sha256}"` };
      if (!strongValidator(tile.etag)) throw fail('DATASET', 'A strong tile validator is required.');
      const key = `${offset}:${size}`;
      if (this.byRange.has(key) || this.byUrl.has(url)) throw fail('DATASET', 'Duplicate tile entry.');
      this.byRange.set(key, tile);
      this.byUrl.set(url, tile);
    }
    if (BigInt(this.byRange.size) * 16n !== this.indexSize) throw fail('DATASET', 'Index tile count mismatch.');
    this.metrics = { requests: 0, tileDownloads: 0, bytes: 0, metadataBytes: 0, sequentialWaitMs: 0, deduplicated: 0, retries: 0 };
    this.trace = [];
  }

  objectSize(url: string): number { return Number(this.byUrl.get(url)?.size ?? 0n); }
  abort() { for (const controller of this.controllers) controller.abort(); }

  async retry<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(fail('TIMEOUT', 'Tile request timed out.', true)), this.timeoutMs);
      try { return await operation(controller.signal); }
      catch (error) {
        const typed = controller.signal.aborted ? (controller.signal.reason instanceof RoutingError ? controller.signal.reason : fail('CANCELLED', 'Fetch cancelled.')) :
          error instanceof RoutingError ? error : fail('NETWORK', 'Tile download failed.', true);
        if (!typed.retryable || attempt >= this.retries) throw typed;
        this.metrics.retries++;
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
  }

  get(url: string, offset = 0n, size = 0n): Promise<Uint8Array<ArrayBuffer>> {
    const key = `${url}:${offset}:${size}`;
    if (this.inflight.has(key)) { this.metrics.deduplicated++; return this.inflight.get(key)!; }
    const promise = this.download(url, offset, size).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async download(url: string, offset: bigint, size: bigint): Promise<Uint8Array<ArrayBuffer>> {
    const archive = url === this.archiveUrl;
    const tile = archive ? this.byRange.get(`${offset}:${size}`) : this.byUrl.get(url);
    const header = archive && offset === 0n && size === 512n;
    const index = archive && offset === 512n && size === this.indexSize;
    if (!tile && !header && !index) throw fail('DATASET', 'Request is absent from the release index.');
    const expected = Number(archive ? size : tile!.size);
    const hash = header ? this.manifest.archive.headerSha256 : index ? this.manifest.archive.indexSha256 : tile!.sha256;
    const started = performance.now();
    this.onProgress?.({ phase: tile ? 'fetching-tile' : 'initializing-graph', tileId: tile?.id });
    try {
      return await this.retry(async signal => {
        this.metrics.requests++;
        const response = await fetch(url, { headers: archive ? { Range: `bytes=${offset}-${offset + size - 1n}` } : {}, credentials: 'omit', signal });
        try {
          if (response.status === 429 || response.status >= 500) throw fail('NETWORK', `HTTP ${response.status}.`, true);
          if (response.status === 401 || response.status === 403) throw fail('ACCESS_DENIED', `Graph access denied: HTTP ${response.status}.`);
          if (response.status === 404) throw fail('INCOMPLETE_DATASET', 'Expected graph object is missing.');
          if (response.status !== (archive ? 206 : 200)) throw fail(archive ? 'RANGE_UNSUPPORTED' : 'DATASET', `Unexpected HTTP ${response.status}.`);
          if (response.headers.get('ETag') !== (archive ? this.manifest.archive.etag : tile!.etag)) throw fail('DATASET_MISMATCH', 'Graph object validator changed.');
          if (archive && response.headers.get('Content-Range') !== `bytes ${offset}-${offset + size - 1n}/${this.archiveSize}`)
            throw fail('INVALID_RANGE', 'Content-Range does not match the requested bytes.');
          if (response.headers.get('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity') throw fail('DATASET', 'Encoded graph responses are unsupported.');
          const length = response.headers.get('Content-Length');
          if (length !== null && length !== String(expected)) throw fail('DATASET', 'Content-Length mismatch.');
          const bytes = await readBounded(response, expected, signal);
          if (await sha256(bytes) !== hash) throw fail('CORRUPT_TILE', 'Graph bytes failed integrity validation.');
          if (index) this.validateIndex(bytes);
          if (header) this.validateHeader(bytes);
          if (tile) {
            const id = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true) & ((1n << 46n) - 1n);
            if (id !== BigInt(tile.id)) throw fail('CORRUPT_TILE', 'Tile header identifier mismatch.');
            this.metrics.tileDownloads++;
          } else this.metrics.metadataBytes += expected;
          this.metrics.bytes += expected;
          this.trace.push({ url, offset: String(offset), size: String(size || tile!.size), tileId: tile?.id, elapsedMs: performance.now() - started,
            http: Object.fromEntries(['etag', 'cache-control', 'cf-cache-status', 'age', 'cf-ray', 'timing-allow-origin'].map(name => [name, response.headers.get(name)])) });
          if (this.trace.length > 2048) this.trace.shift();
          return bytes;
        } finally {
          // In particular, never deliberately consume an ignored Range response.
          if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
        }
      });
    } finally { this.metrics.sequentialWaitMs += performance.now() - started; }
  }

  validateHeader(bytes: Uint8Array) {
    const text = new TextDecoder();
    const name = text.decode(bytes.subarray(0, 100)).split('\0')[0];
    const sizeText = text.decode(bytes.subarray(124, 136)).replace(/\0.*$/, '').trim();
    if (name !== 'index.bin' || !/^[0-7]+$/.test(sizeText) || BigInt(`0o${sizeText}`) !== this.indexSize)
      throw fail('DATASET', 'Archive does not begin with the native index.');
  }

  validateIndex(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seen = new Set();
    for (let i = 0; i < bytes.length; i += 16) {
      const offset = view.getBigUint64(i, true);
      const id = String(view.getUint32(i + 8, true));
      const size = BigInt(view.getUint32(i + 12, true));
      if (this.byRange.get(`${offset}:${size}`)?.id !== id || seen.has(id)) throw fail('DATASET', 'Native index disagrees with release metadata.');
      seen.add(id);
    }
  }

  async head(url: string): Promise<number> {
    if (url !== this.archiveUrl) throw fail('DATASET', 'Unknown metadata object.');
    return this.retry(async signal => {
      this.metrics.requests++;
      const response = await fetch(url, { method: 'HEAD', credentials: 'omit', signal });
      if (!response.ok || response.headers.get('ETag') !== this.manifest.archive.etag ||
          response.headers.get('Content-Length') !== String(this.archiveSize)) throw fail('DATASET_MISMATCH', 'Graph metadata changed.');
      const date = Date.parse(response.headers.get('Last-Modified') ?? '');
      if (!Number.isFinite(date)) throw fail('DATASET', 'Missing last-modified metadata.');
      return Math.floor(date / 1000);
    });
  }
}
