import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { packedFixture, readJSON, staticHost, listen, closeHost, routeProof, writeReport, device } from './package-support.js';

const fixture = await packedFixture();
const graph = createRangeServer({ faults: true });
const graphOrigin = await listen(graph);
const cdn = staticHost({ packageRoot: fixture.packageRoot });
const cdnOrigin = await listen(cdn);
const sdkUrl = `${cdnOrigin}/sdk/0.0.1/dist/index.js`;
const csp = `default-src 'none'; script-src 'self' ${cdnOrigin} 'wasm-unsafe-eval'; connect-src 'self' ${cdnOrigin} ${graphOrigin}; worker-src 'self'`;
const app = staticHost();
const appOrigin = await listen(app);
const strictApp = staticHost({ packageRoot: fixture.packageRoot, csp });
const strictOrigin = await listen(strictApp);
const corpora = await Promise.all(['fixtures', 'fixtures/region'].map(async dir => ({ manifest: await readJSON(`${dir}/manifest.json`), reference: await readJSON(`${dir}/reference.json`) })));
const { manifest, reference } = corpora[0];
const manifestUrl = `${graphOrigin}/datasets/${manifest.release}/manifest.json`;
const cross = reference.cases.find(c => c.name === 'cross-tile');
const report = { at: new Date().toISOString(), device: device(), package: fixture.pack.filename,
  delivery: 'Unpacked npm tarball on a separate loopback origin; app, SDK and graph have distinct origins. No security bypass or CDN publication.',
  versions: fixture.pkg.devDependencies, wasmBytes: fixture.wasmBytes, cases: [], tests: [], passed: false };

async function check(engine, name, body) {
  const start = performance.now();
  let timer;
  try {
    await Promise.race([body(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${engine} ${name}`)), 45000); })]);
    report.tests.push({ engine, name, passed: true, elapsedMs: performance.now() - start });
    console.log(`PASS CDN import: ${engine} ${name}`);
  } catch (error) {
    report.tests.push({ engine, name, passed: false, error: error.message });
    throw error;
  } finally { clearTimeout(timer); }
}
async function load(page, origin = appOrigin) {
  await page.goto(origin);
  await page.evaluate(async sdkUrl => {
    // Track bootstrap resource ownership without intercepting any network requests.
    window.blobs = { created: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { window.blobs.created++; return create(value); };
    URL.revokeObjectURL = value => { window.blobs.revoked++; return revoke(value); };
    window.sdk = await import(sdkUrl);
  }, sdkUrl);
}

try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    if (process.env.BROWSER && process.env.BROWSER !== engine) continue;
    const browser = await launcher.launch();
    try {
      for (const corpus of corpora) for (const transport of ['indexed-tar', 'individual-tiles']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          const mark = cdn.records.length;
          await load(page);
          assert(cdn.records.slice(mark).every(r => r.path.endsWith('index.js')), 'Import alone must not load worker or WASM');
          const graphMark = graph.records.length;
          const result = await routeProof(page, { manifestUrl: `${graphOrigin}/datasets/${corpus.manifest.release}/manifest.json`, reference: corpus.reference, transport });
          // Check every native corpus case, including no-route and outside coverage.
          for (const entry of corpus.reference.cases) {
            const actual = await page.evaluate(async request => {
              try { return { result: await window.router.route(request) }; }
              catch (e) { return { error: { code: e.code, nativeCode: e.nativeCode } }; }
            }, entry.request);
            if (entry.expected.nativeError === 171) assert.equal(actual.error?.code, 'OUTSIDE_COVERAGE');
            else if (entry.expected.nativeError !== undefined) assert.equal(actual.error?.nativeCode, entry.expected.nativeError);
            else assert.deepEqual(actual.result.native, entry.expected);
          }
          const blobs = await page.evaluate(() => window.blobs);
          assert.equal(blobs.created, 1); assert.equal(blobs.revoked, 1);
          const runtime = cdn.records.slice(mark);
          assert.equal(runtime.filter(r => r.path.endsWith('.wasm') && r.status === 200).length, 1);
          assert.equal(runtime.filter(r => r.path.endsWith('worker.js') && r.status === 200).length, 1);
          const ranges = graph.records.slice(graphMark).filter(r => r.path.endsWith('graph.tar'));
          assert(ranges.every(r => r.status === 206 && r.range && r.bodyBytes < Number(corpus.manifest.archive.size)));
          report.cases.push({ engine, browser: browser.version(), release: corpus.manifest.release, transport, startup: result.startup,
            cold: result.cold.diagnostics, warm: result.warm.diagnostics, runtimeRequests: runtime, nativeCases: corpus.reference.cases.length });
          console.log(`PASS CDN import: ${engine} ${corpus.manifest.release} ${transport}`);
        } finally { await context.close(); }
      }

      let page = await browser.newPage();
      const open = async (origin = appOrigin) => {
        await page.close();
        page = await browser.newPage();
        await load(page, origin);
      };
      for (const [name, fault, code] of [
        ['missing worker', { match: 'worker.js', status: 404, remaining: 20 }, 'WORKER_FAILED'],
        ['worker CORS', { match: 'worker.js', noCors: true, remaining: 20 }, 'WORKER_FAILED'],
        ['worker startup timeout', { match: 'worker.js', delayMs: 2000, remaining: 20 }, 'WORKER_FAILED'],
        ['missing WASM', { match: '.wasm', status: 404, remaining: 20 }, 'RUNTIME'],
        ['WASM CORS', { match: '.wasm', noCors: true, remaining: 20 }, 'RUNTIME'],
        ['WASM startup timeout', { match: '.wasm', delayMs: 12000, remaining: 20 }, 'TIMEOUT'],
      ]) {
        await check(engine, `${name} rejects and same Router recovers`, async () => {
          await open(); cdn.setFault(fault);
          const failed = await page.evaluate(async manifestUrl => {
            window.router = new window.sdk.Router({ manifestUrl, timeoutMs: 1000, retries: 0 });
            return window.router.initialize().then(() => null, error => ({ code: error.code }));
          }, manifestUrl);
          assert.equal(failed?.code, code);
          cdn.setFault(null);
          const next = await page.evaluate(async request => window.router.route(request), cross.request);
          assert.deepEqual(next.native, cross.expected);
          await page.evaluate(() => window.router.dispose());
          const blobs = await page.evaluate(() => window.blobs);
          assert.equal(blobs.created, blobs.revoked);
        });
      }
      await check(engine, 'cancel pending import and recover without leaking bootstrap URLs', async () => {
        await open(); cdn.setFault({ match: 'worker.js', delayMs: 2000 });
        const cancelled = await page.evaluate(async manifestUrl => {
          window.router = new window.sdk.Router({ manifestUrl });
          const pending = window.router.initialize().then(() => 'stale', e => e.code);
          window.router.cancel();
          return pending;
        }, manifestUrl);
        assert.equal(cancelled, 'CANCELLED');
        cdn.setFault(null);
        assert.deepEqual((await page.evaluate(request => window.router.route(request), cross.request)).native, cross.expected);
        await page.evaluate(() => window.router.dispose());
        const blobs = await page.evaluate(() => window.blobs);
        assert.equal(blobs.created, blobs.revoked);
      });
      await check(engine, 'concurrent calls, suspended-fetch cancellation, and subsequent route', async () => {
        await open();
        await page.evaluate(async manifestUrl => {
          window.events = [];
          window.router = new window.sdk.Router({ manifestUrl, onProgress: e => window.events.push(e) });
          await window.router.initialize();
        }, manifestUrl);
        graph.setFault({ type: 'delay', match: 'graph.tar', tileOnly: true, delayMs: 1500 });
        await page.evaluate(request => {
          window.pending = Promise.allSettled([window.router.route(request), window.router.route(request)]).then(results => results.map(r => r.status === 'rejected' ? r.reason.code : 'stale'));
        }, cross.request);
        await page.waitForFunction(() => window.events.some(e => e.phase === 'fetching-tile'));
        await page.evaluate(() => window.router.cancel());
        assert.deepEqual(await page.evaluate(() => window.pending), ['CANCELLED', 'CANCELLED']);
        graph.setFault(null);
        assert.deepEqual((await page.evaluate(request => window.router.route(request), cross.request)).native, cross.expected);
        await page.evaluate(() => window.router.dispose());
      });
      await check(engine, 'strict CSP rejects blob worker; same-origin asset overrides work', async () => {
        await open(strictOrigin);
        const failed = await page.evaluate(async manifestUrl => {
          const router = new window.sdk.Router({ manifestUrl, timeoutMs: 1000 });
          try { await router.initialize(); return null; } catch (e) { return e.code; } finally { await router.dispose(); }
        }, manifestUrl);
        assert.equal(failed, 'WORKER_FAILED');
        const before = await page.evaluate(() => window.blobs.created);
        await routeProof(page, { manifestUrl, reference, options: { workerUrl: '/sdk/0.0.1/dist/worker.js', wasmUrl: '/sdk/0.0.1/dist/valhalla-browser.wasm' } });
        assert.equal(await page.evaluate(() => window.blobs.created), before);
        await page.evaluate(() => window.router.dispose());
      });
      await page.close();
    } finally { await browser.close(); }
  }
  report.passed = true;
} finally {
  report.graphRequests = graph.records;
  report.sdkRequests = cdn.records;
  report.overrideRequests = strictApp.records;
  await Promise.all([graph, cdn, app, strictApp].map(closeHost));
  await writeReport('cdn-import', report);
}
