import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { packedFixture, execute, readJSON, listen, closeHost, routeProof, writeReport, device } from './package-support.js';

const fixture = await packedFixture();
const consumer = path.join(fixture.directory, 'consumer');
await mkdir(consumer);
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module', packageManager: 'pnpm@12.4.2',
  dependencies: { [fixture.pkg.name]: `file:${fixture.tarball}` },
  devDependencies: { vite: fixture.pkg.devDependencies.vite, typescript: fixture.pkg.devDependencies.typescript } }));
// pnpm install --frozen-lockfile has already cached these exact toolchain versions. The SDK has no install hook.
await execute('pnpm', ['install', '--offline', '--ignore-scripts'], { cwd: consumer, maxBuffer: 4 * 1024 * 1024 });
await writeFile(path.join(consumer, 'index.html'), '<!doctype html><script type="module" src="./main.ts"></script>');
await writeFile(path.join(consumer, 'main.ts'), `import * as sdk from 'valhalla-browser';
import type { RouteRequest, RouterOptions, RouteResult, StartupResult, Diagnostics } from 'valhalla-browser';
(globalThis as unknown as { sdk: typeof sdk }).sdk = sdk;
const request: RouteRequest = { origin: {lat: 47, lon: 9}, destination: {lat: 47.1, lon: 9.1} };
const options: RouterOptions = { manifestUrl: '/graph/manifest.json', workerUrl: new URL('/worker.js', location.href), wasmUrl: '/runtime.wasm' };
function check(router: sdk.Router) {
  const result: Promise<RouteResult> = router.route(request);
  const startup: Promise<StartupResult> = router.initialize();
  const diagnostics: Promise<Diagnostics> = router.diagnostics();
  // @ts-expect-error Unvalidated costing must not be accepted.
  router.route({ ...request, costing: 'bicycle' });
  // @ts-expect-error Latitude is numeric.
  router.route({ origin: {lat: '47', lon: 9}, destination: {lat: 48, lon: 9} });
  return { result, startup, diagnostics, options };
}
void check;
`);
await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES2022', 'DOM'] }, include: ['main.ts'] }));
await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: consumer });
await execute(process.execPath, ['--input-type=module', '-e', "const m = await import('valhalla-browser'); if(typeof m.createRouter !== 'function') throw Error('Missing export');"], { cwd: consumer });
const { createServer, build, preview } = await import(pathToFileURL(path.join(consumer, 'node_modules/vite/dist/node/index.js')));
const graph = createRangeServer({ faults: true });
const graphOrigin = await listen(graph);
const manifest = await readJSON('fixtures/manifest.json');
const reference = await readJSON('fixtures/reference.json');
const report = { at: new Date().toISOString(), device: device(), tarball: fixture.pack.filename,
  packageBytes: fixture.pack.size, unpackedBytes: fixture.pack.unpackedSize, files: fixture.pack.files,
  wasmBytes: fixture.wasmBytes, wasmSha256: fixture.wasmSha256, versions: fixture.pkg.devDependencies, cases: [], passed: false };
let host;
try {
  for (const mode of ['development', 'production']) {
    const config = { root: consumer, configFile: false, base: '/nested/app/', publicDir: false, logLevel: 'warn' };
    if (mode === 'production') {
      await build(config);
      const assets = await readdir(path.join(consumer, 'dist/assets'));
      assert.equal(assets.filter(f => f.endsWith('.wasm')).length, 1);
      assert(assets.some(f => f.startsWith('worker-') && f.endsWith('.js')));
      host = await preview({ ...config, preview: { host: 'localhost', port: 0 } });
    } else {
      host = await createServer({ ...config, server: { host: 'localhost', port: 0, fs: { strict: true, allow: [consumer] } } });
      await host.listen();
    }
    for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
      const browser = await launcher.launch();
      try {
        const page = await browser.newPage();
        const requests = [];
        page.on('request', req => requests.push(req.url()));
        await page.goto(host.resolvedUrls.local[0]);
        await page.waitForFunction(() => !!window.sdk);
        assert(!requests.some(url => url.includes('worker-') || url.endsWith('.wasm')), 'Import must not load the engine');
        for (const transport of ['indexed-tar', 'individual-tiles']) {
          const mark = graph.records.length;
          const result = await routeProof(page, { manifestUrl: `${graphOrigin}/datasets/${manifest.release}/manifest.json`, reference, transport });
          const graphRecords = graph.records.slice(mark).filter(r => r.path.endsWith('graph.tar'));
          assert(graphRecords.every(r => r.status === 206 && r.range && r.bodyBytes < Number(manifest.archive.size)));
          const subsequent = await page.evaluate(async request => { window.router.cancel(); const next = await window.router.route(request); await window.router.dispose(); return next; }, reference.cases.find(c => c.name === 'cross-tile').request);
          assert.deepEqual(subsequent.native, reference.cases.find(c => c.name === 'cross-tile').expected);
          report.cases.push({ engine, browser: browser.version(), mode, transport, startup: result.startup, cold: result.cold.diagnostics, warm: result.warm.diagnostics });
          console.log(`PASS installed package: ${engine} ${mode} ${transport}`);
        }
        assert(requests.filter(url => !url.startsWith(graphOrigin)).every(url => !url.includes('/src/') && !url.includes('/public/wasm/')));
      } finally { await browser.close(); }
    }
    if (mode === 'production') await new Promise(resolve => host.httpServer.close(resolve));
    else await host.close();
    host = undefined;
  }
  report.passed = true;
} finally {
  if (host?.close) await host.close();
  else if (host?.httpServer) await new Promise(resolve => host.httpServer.close(resolve));
  await closeHost(graph);
  await writeReport('package', report);
}
