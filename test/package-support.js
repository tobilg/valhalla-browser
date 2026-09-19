import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const execute = promisify(execFile);
export const root = fileURLToPath(new URL('../', import.meta.url));
export const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const device = () => ({ platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem() });

export async function packedFixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'valhalla-package-')));
  const sdkRoot = path.join(root, 'packages/valhalla-browser');
  const sourcePkg = await readJSON(path.join(sdkRoot, 'package.json'));
  let tarball = process.env.SDK_TARBALL && path.resolve(root, process.env.SDK_TARBALL);
  if (!tarball) {
    await execute('pnpm', ['--filter', 'valhalla-browser', 'pack', '--pack-destination', directory], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    tarball = path.join(directory, `valhalla-browser-${sourcePkg.version}.tgz`);
  }
  const { stdout: listing } = await execute('tar', ['-tzf', tarball]);
  assert(listing.trim().split('\n').every(n => n.startsWith('package/') && !n.split('/').includes('..')), 'Unexpected archive path');
  await execute('tar', ['-xzf', tarball, '-C', directory]);
  const packageRoot = path.join(directory, 'package');
  const pkg = await readJSON(path.join(packageRoot, 'package.json'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.exports['.'].require, undefined);
  assert(!pkg.scripts.install && !pkg.scripts.postinstall && !pkg.scripts.prepare);
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  const entries = [];
  async function inventory(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isDirectory()) await inventory(path.join(dir, item.name), `${relative}/`);
      else { assert(item.isFile(), 'Package must contain ordinary files'); entries.push({ path: relative, size: (await stat(path.join(dir, item.name))).size }); }
    }
  }
  await inventory(packageRoot);
  const pack = { filename: path.basename(tarball), size: (await stat(tarball)).size, unpackedSize: entries.reduce((n, f) => n + f.size, 0), files: entries.sort((a, b) => a.path.localeCompare(b.path)) };
  const files = pack.files.map(f => f.path);
  assert.equal(pkg.name, 'valhalla-browser');
  assert.equal(await readFile(path.join(packageRoot, 'README.md'), 'utf8'), await readFile(path.join(root, 'README.md'), 'utf8'));
  assert(files.every(file => /^(dist\/|package\.json$|README\.md$|NOTICE\.md$|LICENSE$)/.test(file)), 'Unexpected npm package content');
  assert.equal(files.filter(file => file.endsWith('.wasm')).length, 1);
  for (const required of ['dist/index.js', 'dist/worker.js', 'dist/valhalla-browser.wasm', 'dist/client.d.ts',
    'dist/types.d.ts', 'dist/licenses/SDK.txt', 'dist/licenses/Valhalla.txt', 'dist/licenses/Emscripten.txt', 'dist/runtime.json']) assert(files.includes(required), required);
  assert(!files.some(file => /\.cjs$|graph\.tar$|\.gph$|\.env/.test(file)));
  const wasm = await readFile(path.join(packageRoot, 'dist/valhalla-browser.wasm'));
  const provenance = await readJSON(path.join(packageRoot, 'dist/runtime.json'));
  assert.equal(sha256(wasm), provenance.artifacts['public/wasm/valhalla-browser.wasm'].sha256);
  const client = await readFile(path.join(packageRoot, 'dist/index.js'), 'utf8');
  assert(!client.includes('data:application/wasm') && !client.includes('/public/wasm/') && !client.includes('/src/'));
  return { directory, tarball, packageRoot, pkg, pack, wasmBytes: wasm.length, wasmSha256: sha256(wasm) };
}

// A static CDN analogue: only files from the unpacked tarball are accessible.
// A second instance can serve an empty application document at another origin.
export function staticHost({ packageRoot, html = '<!doctype html><title>Package consumer</title>', csp } = {}) {
  const records = [];
  let fault;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const record = { path: url.pathname, origin: req.headers.origin ?? null, status: 0, bytes: 0 };
    records.push(record);
    const active = fault && url.pathname.includes(fault.match) && fault;
    if (active && --active.remaining <= 0) fault = undefined;
    if (!active?.noCors) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Timing-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (active?.delayMs) await new Promise(resolve => setTimeout(resolve, active.delayMs));
    if (req.destroyed) return;
    if (active?.status) { record.status = active.status; res.writeHead(active.status); res.end(); return; }
    try {
      let bytes;
      if (url.pathname === '/') {
        bytes = Buffer.from(html);
        res.setHeader('Content-Type', 'text/html');
      } else {
        if (!packageRoot || !url.pathname.startsWith('/sdk/0.0.1/')) throw new Error('Missing asset');
        const relative = decodeURIComponent(url.pathname.slice('/sdk/0.0.1/'.length));
        const file = path.resolve(packageRoot, relative);
        if (!file.startsWith(path.resolve(packageRoot) + path.sep)) throw new Error('Invalid path');
        bytes = await readFile(file);
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/json');
      }
      record.status = 200; record.bytes = bytes.length;
      res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes);
    } catch { record.status = 404; res.writeHead(404); res.end(); }
  });
  return { server, records, setFault: value => { fault = value && { remaining: 1, ...value }; } };
}

export async function listen(host) {
  host.server.listen(0, '127.0.0.1'); await once(host.server, 'listening');
  return `http://127.0.0.1:${host.server.address().port}`;
}
export async function closeHost(host) {
  host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve));
}

export async function routeProof(page, { manifestUrl, reference, transport = 'indexed-tar', options = {} }) {
  const fixture = reference.cases.find(c => c.name === 'cross-tile') ?? reference.cases.find(c => c.name === 'balzers-ruggell');
  const result = await page.evaluate(async ({ manifestUrl, request, transport, options }) => {
    window.events = [];
    window.router = new window.sdk.Router({ manifestUrl, transport, ...options, onProgress: event => window.events.push(event) });
    const startup = await window.router.initialize();
    const cold = await window.router.route(request);
    const warm = await window.router.route(request);
    const diagnostics = await window.router.diagnostics();
    return { startup, cold, warm, diagnostics };
  }, { manifestUrl, request: fixture.request, transport, options });
  assert.deepEqual(result.cold.native, fixture.expected);
  assert.deepEqual(result.warm.native, fixture.expected);
  assert(result.cold.diagnostics.loader.tileDownloads >= 2);
  assert.equal(result.warm.diagnostics.loader.requests, 0);
  assert(result.warm.diagnostics.decodedCacheHits > 0);
  assert.equal(result.cold.dataset.release, reference.release);
  for (const costing of ['bicycle', 'pedestrian', 'truck']) {
    const profile = reference.cases.find(c => c.name === `${fixture.name}-${costing}`);
    assert(profile, `Missing ${costing} package reference`);
    const native = await page.evaluate(async request => (await window.router.route(request)).native, profile.request);
    assert.deepEqual(native, profile.expected, `Packaged SDK profile ${costing}`);
  }
  return result;
}

export async function writeReport(name, report) {
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, `test-results/${name}.json`), JSON.stringify(report, null, 2) + '\n');
}
