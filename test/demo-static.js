// Serve only the built demo files, without the repository's Vite data middleware.
// The graph is served at a separate origin; journey inputs must be bundled.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { preview } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { root, execute, listen, closeHost, readJSON, writeReport } from './package-support.js';

const artifact = process.argv.includes('--artifact');
const requests = await readJSON(path.join(root, 'fixtures/region/requests.json'));
const reference = await readJSON(path.join(root, 'fixtures/region/reference.json'));
const manifest = await readJSON(path.join(root, 'fixtures/region/manifest.json'));
const demoRoot = path.join(root, 'packages/demo');
const host = artifact ? null : createRangeServer({ faults: true });
let server;
const report = { at: new Date().toISOString(), mode: artifact ? 'configured-artifact-startup' : 'static-cross-origin-routing', browsers: [], passed: false };
try {
  const graphOrigin = host ? await listen(host) : null;
  const manifestUrl = artifact ? process.env.VITE_DEMO_MANIFEST_URL?.trim()
    : `${graphOrigin}/datasets/${manifest.release}/manifest.json`;
  assert(manifestUrl, 'VITE_DEMO_MANIFEST_URL is required for --artifact');
  let output = path.join(demoRoot, 'dist');
  if (!artifact) {
    await mkdir(path.join(root, 'build'), { recursive: true });
    output = await mkdtemp(path.join(root, 'build/demo-static-'));
    await execute(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', output], {
      cwd: demoRoot, env: { ...process.env, VITE_DEMO_MANIFEST_URL: manifestUrl }, maxBuffer: 4 * 1024 * 1024,
    });
  }
  const assets = await readdir(path.join(output, 'assets'));
  const entry = assets.find(file => /^index-.*\.js$/.test(file));
  assert(entry);
  assert((await readFile(path.join(output, 'assets', entry), 'utf8')).includes(manifestUrl), 'Manifest URL must be compiled into the deployed app');
  assert.equal(assets.filter(file => file.endsWith('.wasm')).length, 1);
  server = await preview({ configFile: false, root: demoRoot, publicDir: false,
    build: { outDir: output }, preview: { host: 'localhost', port: 0, strictPort: true } });
  const base = server.resolvedUrls.local[0];
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    const checks = [];
    try {
      for (const transport of artifact ? ['indexed-tar'] : ['indexed-tar', 'individual-tiles']) {
        const context = await browser.newContext();
        const seen = [], errors = [];
        context.on('request', request => seen.push(request.url()));
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        try {
          await page.goto(base);
          await page.waitForFunction(() => document.querySelector('#preset').value === 'balzers-ruggell');
          assert.equal(await page.locator('#dataset').inputValue(), 'r2-region');
          assert.equal(await page.locator('#dataset option').count(), 1);
          assert.deepEqual(await page.locator('#preset option').evaluateAll(options => options.map(o => o.value)), requests.map(r => r.name));
          assert.match(await page.locator('#attribution').innerText(), /OpenStreetMap.*2015/);
          assert.equal(await page.locator('#from-lat').inputValue(), '47.0666667');
          assert.equal(await page.locator('#to-lat').inputValue(), '47.2397558');
          // Startup must not need the local discovery files, presets or R2.
          assert(seen.every(url => new URL(url).origin === new URL(base).origin));
          assert(!seen.some(url => /\/(manifest\.json|fixtures\/|public\/)/.test(new URL(url).pathname)));
          checks.push(`${transport}: bundled regional presets, attribution and default coordinates`);
          if (!artifact) {
            await page.locator('#transport').selectOption(transport);
            const calculate = async name => {
              await page.locator('#preset').selectOption(name);
              await page.getByRole('button', { name: 'Calculate route' }).click();
              await page.waitForFunction(() => !document.querySelector('#route').disabled);
              const expected = reference.cases.find(item => item.name === name).expected;
              if (expected.nativeError) {
                assert.match(await page.locator('#status').innerText(), /OUTSIDE_COVERAGE/);
                return;
              }
              assert.equal(await page.locator('#status').innerText(), 'Route calculated in your browser.');
              assert.equal(await page.locator('#summary').innerText(), `${expected.trip.summary.length.toFixed(3)} km · ${Math.round(expected.trip.summary.time)} seconds`);
              assert.equal(await page.locator('#geometry polyline').count(), 1);
              assert.deepEqual(await page.locator('#maneuvers li').allTextContents(), expected.trip.legs.flatMap(leg => leg.maneuvers.map(m => m.instruction)));
              const diagnostics = JSON.parse(await page.locator('#diagnostics').textContent());
              assert.equal(diagnostics.dataset.release, reference.release);
              return diagnostics;
            };
            const cold = await calculate('balzers-ruggell');
            assert(cold.route.loader.tileDownloads >= 2);
            const warm = await calculate('balzers-ruggell');
            assert.equal(warm.route.loader.requests, 0);
            for (const request of requests) await calculate(request.name);
            checks.push(`${transport}: every regional preset matches native summary/directions; warm cache reuse`);
            // A transport change creates a new worker so the next route fetches tiles.
            await page.locator('#transport').selectOption(transport === 'indexed-tar' ? 'individual-tiles' : 'indexed-tar');
            await page.locator('#transport').selectOption(transport);
            host.setFault({ type: 'delay', delayMs: 1500, tileOnly: true,
              match: transport === 'indexed-tar' ? 'graph.tar' : '.gph' });
            await page.locator('#preset').selectOption('balzers-ruggell');
            await page.getByRole('button', { name: 'Calculate route' }).click();
            await page.waitForFunction(() => document.querySelector('#status').textContent === 'Loading road data…');
            await page.getByRole('button', { name: 'Cancel', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#status').textContent.includes('CANCELLED'));
            host.setFault(null);
            await calculate('balzers-ruggell');
            checks.push(`${transport}: cancellation and subsequent successful route`);
          }
          assert.deepEqual(errors, []);
          assert(!seen.some(url => new URL(url).origin === new URL(base).origin &&
            /\/(manifest\.json|datasets\/|fixtures\/|public\/)/.test(new URL(url).pathname)));
        } finally { await context.close(); }
      }
      report.browsers.push({ engine, version: browser.version(), checks, passed: true });
      console.log(`PASS static demo: ${engine} (${report.mode})`);
    } finally { await browser.close(); }
  }
  if (host) {
    const ranges = host.records.filter(record => record.path.endsWith('/graph.tar') && record.method === 'GET');
    assert(ranges.length > 0);
    assert(ranges.every(record => record.status === 206 && record.range && record.bodyBytes < Number(manifest.archive.size)));
    report.archiveRequests = ranges.length;
  }
  report.passed = true;
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (host) await closeHost(host);
  await writeReport(artifact ? 'demo-artifact' : 'demo-static', report);
}
