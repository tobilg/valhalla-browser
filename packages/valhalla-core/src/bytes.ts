import { RoutingError } from './errors.js';
const fail = (code: 'DATASET', message: string) => new RoutingError(code, message);

export async function readBounded(response: Response, expected: number, signal?: AbortSignal, { exact = true } = {}): Promise<Uint8Array<ArrayBuffer>> {
  return readStream(response.body, expected, signal, { exact });
}

export async function readStream(body: ReadableStream<Uint8Array> | null, expected: number, signal?: AbortSignal, { exact = true } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body?.getReader();
  if (!reader) throw fail('DATASET', 'Response has no body.');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const bytes = new Uint8Array(expected);
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (length + value.length > expected) throw fail('DATASET', 'Response exceeds expected size.');
      bytes.set(value, length);
      length += value.length;
    }
    if (exact && length !== expected) throw fail('DATASET', 'Truncated response.');
    return length === expected ? bytes : bytes.slice(0, length);
  } finally {
    signal?.removeEventListener('abort', abort);
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

