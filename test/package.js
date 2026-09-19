import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { packedFixture, execute, readJSON, listen, closeHost, routeProof, writeReport, device } from './package-support.js';

const engines = { chromium, firefox, webkit };
if (process.env.BROWSER && !Object.hasOwn(engines, process.env.BROWSER)) throw new Error(`Unknown BROWSER: ${process.env.BROWSER}`);
const fixture = await packedFixture();
const consumer = path.join(fixture.directory, 'consumer');
await mkdir(consumer);
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module', packageManager: 'pnpm@12.4.2',
  dependencies: { [fixture.pkg.name]: `file:${fixture.tarball}` },
  devDependencies: { vite: fixture.pkg.devDependencies.vite, typescript: fixture.pkg.devDependencies.typescript } }));
// A frozen workspace install caches package bytes, but not all resolution metadata
// needed by a new consumer (including pnpm's own version). Reuse cached data and
// fetch missing metadata; only this temporary project may generate a new lockfile.
await execute('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: consumer, maxBuffer: 4 * 1024 * 1024 });
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
  router.route({ ...request, costing: 'bicycle', costing_options: { bicycle: { cycling_speed: 20 } } });
  router.route({ ...request, costing: 'pedestrian', costing_options: { pedestrian: { walking_speed: 4 } } });
  router.route({ ...request, costing: 'truck', costing_options: { truck: { height: 3, hazmat: false } } });
  // @ts-expect-error Transit remains unsupported.
  router.route({ ...request, costing: 'transit' });
  // @ts-expect-error Settings must match the selected profile.
  router.route({ ...request, costing: 'bicycle', costing_options: { truck: { height: 3 } } });
  // @ts-expect-error Arbitrary native options are not exposed.
  router.route({ ...request, costing: 'truck', costing_options: { truck: { ignore_restrictions: true } } });
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
    for (const [engine, launcher] of Object.entries(engines)) {
      if (process.env.BROWSER && process.env.BROWSER !== engine) continue;
      const browser = await launcher.launch();
      try {
        for (const transport of ['indexed-tar', 'individual-tiles']) {
          // Isolate independent consumers, including their browser HTTP caches and
          // worker lifetimes. Cancellation/recovery still uses this same page/Router.
          const context = await browser.newContext();
          const page = await context.newPage();
          const entry = { engine, browser: browser.version(), mode, transport, stage: 'import', passed: false };
          report.cases.push(entry);
          const requests = [];
          const browserErrors = [];
          page.on('request', req => requests.push(req.url()));
          page.on('pageerror', error => browserErrors.push(error.message));
          page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
          page.on('requestfailed', request => browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
          try {
            await page.goto(host.resolvedUrls.local[0]);
            await page.waitForFunction(() => !!window.sdk);
            assert(!requests.some(url => url.includes('worker-') || url.endsWith('.wasm')), 'Import must not load the engine');
            entry.stage = 'cold and warm routes';
            const mark = graph.records.length;
            const result = await routeProof(page, { manifestUrl: `${graphOrigin}/datasets/${manifest.release}/manifest.json`, reference, transport });
            Object.assign(entry, { startup: result.startup, cold: result.cold.diagnostics, warm: result.warm.diagnostics });
            entry.stage = 'cancellation recovery';
            const subsequent = await page.evaluate(async request => {
              window.router.cancel();
              const next = await window.router.route(request);
              const startup = window.router.startup;
              await window.router.dispose();
              return { next, startup };
            }, reference.cases.find(c => c.name === 'cross-tile').request);
            assert.deepEqual(subsequent.next.native, reference.cases.find(c => c.name === 'cross-tile').expected);
            assert(subsequent.next.diagnostics.loader.tileDownloads >= 2, 'Recovery must use a new worker with an empty tile cache');
            entry.recoveryStartup = subsequent.startup;
            entry.recovery = subsequent.next.diagnostics;
            const graphRecords = graph.records.slice(mark).filter(r => r.path.endsWith('graph.tar'));
            assert(graphRecords.every(r => r.status === 206 && r.range && r.bodyBytes < Number(manifest.archive.size)));
            assert(requests.filter(url => !url.startsWith(graphOrigin)).every(url => !url.includes('/src/') && !url.includes('/public/wasm/')));
            entry.passed = true;
            entry.stage = 'complete';
            console.log(`PASS installed package: ${engine} ${mode} ${transport}`);
          } catch (error) {
            entry.error = error.stack;
            entry.browserErrors = browserErrors;
            entry.progress = await page.evaluate(() => window.events).catch(() => null);
            console.error(`FAIL installed package: ${engine} ${mode} ${transport} (${entry.stage})`);
            throw error;
          } finally { await context.close(); }
        }
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
