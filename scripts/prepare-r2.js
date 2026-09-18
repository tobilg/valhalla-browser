// Assemble local files only. Upload remains an explicit operator action.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'fixtures/region/manifest.json')));
const prefix = `datasets/${manifest.release}`;
const source = path.join(root, 'public', prefix);
const output = path.join(root, 'build/r2-upload', prefix);
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const objects = new Map();
const archive = await readFile(path.join(source, 'graph.tar'));
assert.equal(String(archive.length), manifest.archive.size);
assert.equal(`"${hash('sha256', archive)}"`, manifest.archive.etag, 'Canonical local archive hash changed');
assert.equal(hash('sha256', archive.subarray(0, 512)), manifest.archive.headerSha256);
assert.equal(hash('sha256', archive.subarray(512, 512 + Number(manifest.archive.indexSize))), manifest.archive.indexSha256);
objects.set('graph.tar', archive);
const config = await readFile(path.join(source, 'config.json'));
assert.equal(hash('sha256', config), manifest.config.sha256);
objects.set('config.json', config);
// Expected single-PUT validators. Verify actual R2 HEAD responses before testing;
// a multipart upload can produce a different ETag without changing graph bytes.
manifest.archive.etag = `"${hash('md5', archive)}"`;
for (const tile of Object.values(manifest.tiles)) {
  const bytes = await readFile(path.join(source, 'tiles', tile.path));
  assert.equal(String(bytes.length), tile.size);
  assert.equal(hash('sha256', bytes), tile.sha256);
  assert(archive.subarray(Number(tile.offset), Number(tile.offset) + bytes.length).equals(bytes));
  tile.etag = `"${hash('md5', bytes)}"`;
  objects.set(`tiles/${tile.path}`, bytes);
}
manifest.delivery = { kind: 's3', origin: 'Cloudflare R2', validator: 'single-PUT ETags; verify against uploaded objects before measurement' };
objects.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
for (const [name, bytes] of objects) {
  const target = path.join(output, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const inventory = [...objects].map(([name, bytes]) => ({ key: `${prefix}/${name}`, bytes: bytes.length, sha256: hash('sha256', bytes) }));
await writeFile(path.join(root, 'build/r2-upload-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ output, keyPrefix: prefix, uploadManifest: path.join(output, 'manifest.json'), files: objects.size,
  totalBytes: inventory.reduce((total, item) => total + item.bytes, 0), archiveBytes: archive.length }, null, 2));
