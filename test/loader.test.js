import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRangeServer } from '../scripts/server.js';
import { TileLoader, integer, readMetadata } from '../packages/valhalla-browser/src/loader.ts';

const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url)));
async function setup(t) {
  const host = createRangeServer({ faults: true });
  host.server.listen(0, '127.0.0.1');
  await once(host.server, 'listening');
  t.after(() => { host.server.closeAllConnections(); host.server.close(); });
  const url = `http://127.0.0.1:${host.server.address().port}/datasets/${manifest.release}/manifest.json`;
  const loader = new TileLoader(manifest, url, { timeoutMs: 500, retries: 1 });
  return { ...host, url, loader };
}

test('native index, exact ranges, full individual tiles, and in-flight deduplication', async t => {
  const { loader, records, url } = await setup(t);
  assert(Number.isFinite(await loader.head(loader.archiveUrl)));
  await loader.get(loader.archiveUrl, 0n, 512n);
  await loader.get(loader.archiveUrl, 512n, loader.indexSize);
  const tile = [...loader.byRange.values()][0];
  const [a, b] = await Promise.all([loader.get(loader.archiveUrl, tile.offset, tile.size), loader.get(loader.archiveUrl, tile.offset, tile.size)]);
  assert.strictEqual(a, b);
  const individual = await loader.get(new URL(`tiles/${tile.path}`, url).href);
  assert.deepEqual(a, individual);
  assert.equal(loader.metrics.deduplicated, 1);
  assert.equal(records.filter(r=>r.range).length, 3);
  assert(records.filter(r=>r.range).every(r=>r.status === 206 && r.bodyBytes < Number(manifest.archive.size)));
});

for (const [type, code] of [['ignore-range','RANGE_UNSUPPORTED'], ['wrong-range','INVALID_RANGE'], ['mismatch','DATASET_MISMATCH']]) {
  test(`reject ${type} and recover`, async t => {
    const { loader, setFault } = await setup(t);
    setFault({ type, match:'graph.tar' });
    await assert.rejects(loader.get(loader.archiveUrl,0n,512n), { code });
    assert.equal((await loader.get(loader.archiveUrl,0n,512n)).length,512);
  });
}

test('truncated bytes fail; a later request succeeds', async t => {
  const { loader, setFault } = await setup(t);
  loader.retries = 0;
  setFault({ type:'truncated',match:'graph.tar' });
  await assert.rejects(loader.get(loader.archiveUrl,0n,512n), error => ['TIMEOUT','NETWORK','DATASET'].includes(error.code));
  assert.equal((await loader.get(loader.archiveUrl,0n,512n)).length,512);
});

test('transient error retries are bounded and recoverable', async t => {
  const { loader, setFault } = await setup(t);
  setFault({ type:'transient',match:'graph.tar',remaining:2 });
  await assert.rejects(loader.get(loader.archiveUrl,0n,512n), {code:'NETWORK',retryable:true});
  assert.equal(loader.metrics.requests,2);
  assert.equal((await loader.get(loader.archiveUrl,0n,512n)).length,512);
});

test('permission failure is explicit and is not retried', async t => {
  const { loader, setFault } = await setup(t);
  setFault({ type:'denied',match:'graph.tar' });
  await assert.rejects(loader.get(loader.archiveUrl,0n,512n), {code:'ACCESS_DENIED',retryable:false});
  assert.equal(loader.metrics.requests,1);
  assert.equal((await loader.get(loader.archiveUrl,0n,512n)).length,512);
});

test('64-bit offsets stay exact and mismatched releases fail before fetch', () => {
  assert.equal(integer('9007199254740993','offset'),9007199254740993n);
  assert.throws(()=>integer(9007199254740993,'offset'), {code:'DATASET'});
  assert.throws(()=>integer('18446744073709551616','offset'), {code:'DATASET'});
  assert.throws(()=>new TileLoader({...manifest,valhallaRevision:'wrong'},`http://localhost/datasets/${manifest.release}/manifest.json`), {code:'INCOMPATIBLE_DATASET'});
});

test('versioned CDN paths accept any prefix but require an exact parent release', () => {
  for (const prefix of ['', 'datasets/', 'routing/graphs/'])
    assert.doesNotThrow(() => new TileLoader(manifest, `https://cdn.example/${prefix}${manifest.release}/manifest.json`));
  for (const path of [`other/manifest.json?/${manifest.release}/`, `${manifest.release}-other/manifest.json`,
    `${manifest.release}/nested/manifest.json`, `manifest.json?x=/datasets/${manifest.release}/`])
    assert.throws(() => new TileLoader(manifest, `https://cdn.example/${path}`), { code: 'DATASET' });
});

test('compressed or chunked metadata has a decoded size limit; exact lengths still detect truncation', async () => {
  const json = '{"example":"decoded metadata"}';
  for (const headers of [{}, { 'Content-Encoding': 'br', 'Content-Length': '12' }])
    assert.equal(new TextDecoder().decode(await readMetadata(new Response(json, { headers }))), json);
  await assert.rejects(readMetadata(new Response(json, { headers: { 'Content-Length': String(json.length + 1) } })), { code: 'DATASET' });
  await assert.rejects(readMetadata(new Response(new Uint8Array(4 * 1024 * 1024 + 1))), { code: 'DATASET' });
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': '4194305' } });
  await assert.rejects(readMetadata(oversized), { code: 'DATASET' });
  assert(cancelled);
});

test('ignored Range is rejected without reading its body', async t => {
  const original = globalThis.fetch;
  t.after(()=> { globalThis.fetch = original; });
  let read = false, cancelled = false;
  globalThis.fetch = async () => ({ status:200, headers:new Headers(), bodyUsed:false,
    body:{ cancel:async()=>{cancelled=true;},getReader:()=>{read=true;throw new Error('Must not read');} } });
  const loader = new TileLoader(manifest,`http://localhost/datasets/${manifest.release}/manifest.json`);
  await assert.rejects(loader.get(loader.archiveUrl,0n,512n), {code:'RANGE_UNSUPPORTED'});
  assert.equal(read,false);assert.equal(cancelled,true);
});
