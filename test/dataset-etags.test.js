import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execute = promisify(execFile);
const script = new URL('../scripts/dataset-etags.js', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'));

async function setup(t, fault) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'valhalla-etags-'));
  const input = path.join(directory, 'manifest.json');
  const output = path.join(directory, 'hosting/manifest.json');
  await writeFile(input, JSON.stringify(manifest));
  const objects = new Map([
    ['graph.tar', manifest.archive.size],
    ...Object.values(manifest.tiles).map(tile => [`tiles/${tile.path}`, tile.size]),
  ]);
  const requests = [];
  const prefix = `/datasets/${manifest.release}/`;
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const relative = req.url.slice(prefix.length);
    const size = objects.get(relative);
    res.setHeader('Content-Length', fault === 'size' ? String(Number(size) + 1) : size);
    if (fault !== 'missing-etag') res.setHeader('ETag', fault === 'weak-etag' ? 'W/"weak"' : '"opaque-multipart-2"');
    if (fault === 'compressed') res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(fault === 'status' ? 404 : 200);
    res.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}${prefix}`;
  const run = () => execute(process.execPath, [script, '--manifest', input, '--base-url', base, '--output', output]);
  return { run, input, output, requests };
}

test('delivery manifest uses public opaque validators without altering graph identity or consuming bodies', async t => {
  const { run, input, output, requests } = await setup(t);
  await run();
  const delivered = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(delivered.archive.etag, '"opaque-multipart-2"');
  for (const tile of Object.values(delivered.tiles)) {
    assert.equal(tile.etag, '"opaque-multipart-2"');
    delete tile.etag;
  }
  delivered.archive.etag = manifest.archive.etag;
  assert.deepEqual(delivered, manifest);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), manifest);
  assert.equal(requests.length, Object.keys(manifest.tiles).length + 1);
  assert(requests.every(request => request.method === 'HEAD'));
  const before = await readFile(output, 'utf8');
  await assert.rejects(run(), /EEXIST/);
  assert.equal(await readFile(output, 'utf8'), before);
});

for (const fault of ['size', 'status', 'weak-etag', 'missing-etag', 'compressed']) {
  test(`delivery manifest rejects ${fault} without writing output`, async t => {
    const { run, output } = await setup(t, fault);
    await assert.rejects(run());
    await assert.rejects(access(output), { code: 'ENOENT' });
  });
}
