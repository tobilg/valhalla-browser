import { RoutingError } from './errors.js';
import { readBounded, readMetadata } from './bytes.js';
import type { DatasetManifest } from './dataset.js';

const omitCredentials = { credentials: 'omit' as const };

export interface ObjectIdentity { total: bigint; etag: string }
export interface ObjectRead extends ObjectIdentity { offset?: bigint; length: number }
export interface ObjectStore {
  validateManifest(manifest: DatasetManifest): void;
  document(url: string | URL, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  read(url: string, range: ObjectRead, signal: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string | null> }>;
  head(url: string, identity: ObjectIdentity, signal: AbortSignal): Promise<number>;
}
const fail = (code: ConstructorParameters<typeof RoutingError>[0], message: string, retryable = false): never => {
  throw new RoutingError(code, message, { retryable });
};
function status(response: Response) {
  if (response.status === 429 || response.status >= 500) fail('NETWORK', `HTTP ${response.status}.`, true);
  if ([401, 403].includes(response.status)) fail('ACCESS_DENIED', `Graph access denied: HTTP ${response.status}.`);
  if (response.status === 404) fail('INCOMPLETE_DATASET', 'Expected graph object is missing.');
}

export class HttpStore implements ObjectStore {
  validateManifest(_manifest: DatasetManifest): void {}
  async document(url: string | URL, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, { ...omitCredentials, signal });
    try { status(response); if (!response.ok) fail('NETWORK', `Metadata HTTP ${response.status}.`); return await readMetadata(response, signal); }
    finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}); }
  }
  async read(url: string, spec: ObjectRead, signal: AbortSignal) {
    const ranged = spec.offset !== undefined;
    const range = `bytes=${spec.offset}-${(spec.offset ?? 0n) + BigInt(spec.length) - 1n}`;
    const response = await fetch(url, { headers: ranged ? { Range: range } : {}, ...omitCredentials, signal });
    try {
      status(response);
      if (response.status !== (ranged ? 206 : 200)) fail(ranged ? 'RANGE_UNSUPPORTED' : 'DATASET', `Unexpected HTTP ${response.status}.`);
      if (response.headers.get('ETag') !== spec.etag) fail('DATASET_MISMATCH', 'Graph object validator changed.');
      if (ranged && response.headers.get('Content-Range') !== `bytes ${spec.offset}-${spec.offset! + BigInt(spec.length) - 1n}/${spec.total}`)
        fail('INVALID_RANGE', 'Content-Range does not match the requested bytes.');
      const encoding = response.headers.get('Content-Encoding');
      if (encoding && encoding !== 'identity') fail('DATASET', 'Encoded graph responses are unsupported.');
      const length = response.headers.get('Content-Length');
      if (length !== null && length !== String(spec.length)) fail('DATASET', 'Content-Length mismatch.');
      const bytes = await readBounded(response, spec.length, signal);
      const headers = Object.fromEntries(['etag', 'cache-control', 'cf-cache-status', 'age', 'cf-ray', 'timing-allow-origin'].map(name => [name, response.headers.get(name)]));
      return { bytes, headers };
    } finally {
      // Reject ignored ranges without deliberately consuming the archive body.
      if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    }
  }
  async head(url: string, identity: ObjectIdentity, signal: AbortSignal): Promise<number> {
    const response = await fetch(url, { method: 'HEAD', ...omitCredentials, signal });
    status(response);
    if (!response.ok || response.headers.get('ETag') !== identity.etag || response.headers.get('Content-Length') !== String(identity.total))
      fail('DATASET_MISMATCH', 'Graph metadata changed.');
    const date = Date.parse(response.headers.get('Last-Modified') ?? '');
    if (!Number.isFinite(date)) fail('DATASET', 'Missing last-modified metadata.');
    return Math.floor(date / 1000);
  }
}
