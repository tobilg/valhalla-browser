import { RoutingError } from '@tobilg/valhalla-core/errors';
import { readStream } from '@tobilg/valhalla-core/bytes';
import type { DatasetManifest } from '@tobilg/valhalla-core/dataset';
import type { ObjectStore, ObjectRead, ObjectIdentity } from '@tobilg/valhalla-core/store';

const fail = (message: string): never => { throw new RoutingError('DATASET_MISMATCH', message); };
const safe = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RoutingError('DATASET', 'R2 offset exceeds the safe integer range.');
  return Number(value);
};

/** Binding-backed graph reads. URLs are internal identities, never HTTP requests. */
export class R2Store implements ObjectStore {
  readonly manifestUrl: string;
  private readonly prefix: string;
  constructor(private readonly bucket: R2Bucket, manifestKey: string) {
    if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(manifestKey) || manifestKey.split('/').some(s => s === '..' || s === '.'))
      throw new RoutingError('INVALID_REQUEST', 'Use a relative R2 manifest key with a versioned parent directory.');
    this.manifestUrl = `https://r2.invalid/${manifestKey}`;
    this.prefix = new URL('.', this.manifestUrl).href;
  }
  private key(url: string | URL): string {
    const parsed = new URL(url);
    if (!parsed.href.startsWith(this.prefix) || parsed.search || parsed.hash || parsed.pathname.includes('%'))
      throw new RoutingError('DATASET', 'R2 graph objects must remain in the manifest version prefix.');
    return parsed.pathname.slice(1);
  }
  validateManifest(manifest: DatasetManifest): void {
    for (const relative of [manifest.config.url, manifest.archive.url]) {
      if (!relative || relative.startsWith('/') || relative.includes(':') || relative.split('/').some(part => part === '..' || part === '.'))
        throw new RoutingError('DATASET', 'R2 manifests require relative object paths within one version prefix.');
      this.key(new URL(relative, this.manifestUrl));
    }
  }
  private identity(object: R2Object, spec: ObjectIdentity): void {
    if (object.httpEtag !== spec.etag || !Number.isSafeInteger(object.size) || BigInt(object.size) !== spec.total)
      fail('R2 object validator or total size changed.');
    if (object.httpMetadata?.contentEncoding && object.httpMetadata.contentEncoding !== 'identity')
      throw new RoutingError('DATASET', 'Encoded graph objects are unsupported.');
  }
  async document(url: string | URL, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted();
    const object = await this.bucket.get(this.key(url));
    if (!object) throw new RoutingError('INCOMPLETE_DATASET', 'R2 metadata object is missing.');
    try {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > 4 * 1024 * 1024)
        throw new RoutingError('DATASET', 'Invalid R2 metadata size.');
      return await readStream(object.body, object.size, signal);
    } finally { if (!object.bodyUsed) await object.body.cancel().catch(() => {}); }
  }
  async read(url: string, spec: ObjectRead, signal: AbortSignal) {
    signal.throwIfAborted();
    safe(spec.total);
    const range = spec.offset === undefined ? undefined : { offset: safe(spec.offset), length: spec.length };
    // R2's get cannot be aborted. Settle it and discard its body before releasing
    // the actor permit; never allow a late read to resume an obsolete actor.
    const object = await this.bucket.get(this.key(url), { range, onlyIf: { etagMatches: spec.etag.slice(1, -1) } });
    if (!object) throw new RoutingError('INCOMPLETE_DATASET', 'Expected R2 graph object is missing.');
    if (!('body' in object)) throw new RoutingError('DATASET_MISMATCH', 'R2 object precondition failed.');
    try {
      signal.throwIfAborted();
      this.identity(object, spec);
      if (range && (!object.range || !('offset' in object.range) || object.range.offset !== range.offset || object.range.length !== range.length))
        throw new RoutingError('INVALID_RANGE', 'R2 returned an unexpected range.');
      return { bytes: await readStream(object.body, spec.length, signal), headers: { etag: object.httpEtag } };
    } finally { if (!object.bodyUsed) await object.body.cancel().catch(() => {}); }
  }
  async head(url: string, spec: ObjectIdentity, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const object = await this.bucket.head(this.key(url));
    signal.throwIfAborted();
    if (!object) throw new RoutingError('INCOMPLETE_DATASET', 'Expected R2 graph object is missing.');
    this.identity(object, spec);
    return Math.floor(object.uploaded.getTime() / 1000);
  }
}
