import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import { createRangeServer } from '../scripts/server.js';
import { readBounded, readMetadata, TileLoader, sha256 } from '../packages/valhalla-browser/src/loader.ts';
import { checkCDNCors } from './cdn-cors.js';

const manifestUrl = process.env.MANIFEST_URL ?? process.argv[2];
if (!manifestUrl || new URL(manifestUrl).protocol !== 'https:')
  throw new Error('Usage: pnpm run test:cdn https://host/release/manifest.json');
const reference = JSON.parse(await readFile('fixtures/region/reference.json'));
const versions = JSON.parse(await readFile('versions.json'));
const long = reference.cases.find(c => c.name === 'balzers-ruggell');
const host = createRangeServer();
host.server.listen(0, '127.0.0.1'); await once(host.server, 'listening');
const base = `http://127.0.0.1:${host.server.address().port}`;
const headerNames = ['access-control-allow-origin', 'access-control-expose-headers', 'content-length',
  'content-range', 'content-encoding', 'content-type', 'etag', 'cache-control', 'age', 'cf-cache-status',
  'cf-ray', 'timing-allow-origin', 'date', 'vary'];
const headers = response => Object.fromEntries(headerNames.map(name => [name, response.headers.get(name)]));
// These successful graph/JSON responses are nonempty. All-zero cross-origin
// sizes without Timing-Allow-Origin are masked values, not zero-byte transfers.
const reportValue = (key, value) => value?.name?.startsWith(new URL(manifestUrl).origin + '/') &&
  value.transferSize === 0 && value.decodedBodySize === 0
  ? { ...value, transferSize: null, encodedBodySize: null, decodedBodySize: null,
    sizeNote: 'Cross-origin Resource Timing sizes unavailable without Timing-Allow-Origin.' } : value;
const report = { at: new Date().toISOString(), manifestUrl, versions,
  device: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem() },
  runtime: { wasmBytes: (await readFile('public/wasm/valhalla.wasm')).length,
    wasmSha256: await sha256(await readFile('public/wasm/valhalla.wasm')) },
  scope: 'Direct public HTTPS fetches from local browser workers; no proxy, interception, cache-busting, CDN purge or network throttling by this runner.',
  originRequests: null, originBytes: null,
  originReason: 'No R2/provider logs. Client ranges do not establish the edge-to-origin transfer size.',
  sampleCounts: { cold: 5, warm: 20 }, probes: [], browsers: [], cases: [], tests: [], benchmarks: [], cache: [] };
const percentile = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};
async function probe(file, range) {
  const url = new URL(file, manifestUrl).href;
  const started = performance.now();
  const response = await fetch(url, { headers: { Origin: base, ...(range ? { Range: range } : {}) }, signal: AbortSignal.timeout(15000) });
  const result = { url, range, status: response.status, headers: headers(response), headersMs: performance.now() - started };
  report.probes.push(result);
  // An unexpected 200 archive response is rejected before reading its body.
  if (response.status !== (range ? 206 : 200)) {
    await response.body?.cancel(); throw new Error(`Unexpected HTTP ${response.status}: ${url}`);
  }
  const bytes = range ? await readBounded(response, 512) : await readMetadata(response);
  Object.assign(result, { decodedBytes: bytes.length, totalMs: performance.now() - started });
  return bytes;
}
async function check(name, body, extra = {}) {
  const started = performance.now();
  try { await body(); report.tests.push({ name, ...extra, passed: true, elapsedMs: performance.now() - started }); console.log(`PASS ${name}`); return true; }
  catch (error) { report.tests.push({ name, ...extra, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); return false; }
}
async function setup(context, transport) {
  const page = await context.newPage(); await page.goto(base);
  await page.evaluate(async options => {
    const { Router } = await import('/dist/index.js');
    window.events = []; window.heartbeats = 0;
    setInterval(() => window.heartbeats++, 10);
    window.router = new Router({ ...options, onProgress: e => window.events.push(e) });
  }, { manifestUrl, transport });
  return page;
}
async function route(page, fixture) {
  const actual = await page.evaluate(async request => {
    try { return { result: await window.router.route(request) }; }
    catch (e) { return { error: { code: e.code, nativeCode: e.nativeCode, message: e.message } }; }
  }, fixture.request);
  if (fixture.expected.nativeError === 171) assert.equal(actual.error?.code, 'OUTSIDE_COVERAGE');
  else if (fixture.expected.nativeError !== undefined) assert.equal(actual.error?.nativeCode, fixture.expected.nativeError);
  else {
    assert(!actual.error, JSON.stringify(actual.error));
    assert.deepEqual(actual.result.native, fixture.expected, `${fixture.name}: native/browser discrepancy`);
    assert.equal(actual.result.dataset.release, reference.release);
    assert.equal(actual.result.dataset.configSha256, reference.configSha256);
  }
  return actual.result?.diagnostics;
}

async function cacheExperiment(engineName, engine, manifest) {
  const profile = await mkdtemp('test-results/cdn-profile-');
  const archive = new URL(manifest.archive.url, manifestUrl).href;
  const tile = Object.values(manifest.tiles)[0];
  const individual = new URL(`tiles/${tile.path}`, manifestUrl).href;
  let context, page, network, completions;
  const seenRays = new Set();
  async function open() {
    context = await engine.launchPersistentContext(profile, { headless: true });
    await openPage();
  }
  async function openPage() {
    page = await context.newPage(); await page.goto(base);
    network = [];
    completions = new Map();
    if (engineName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const records = new Map();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', e => {
        if (!e.request.url.startsWith(new URL('.', manifestUrl).href)) return;
        const record = { url: e.request.url, requestId: e.requestId, requestHeaders: { Range: e.request.headers.Range ?? e.request.headers.range ?? null } };
        records.set(e.requestId, record); network.push(record);
        const completion = {};
        completion.promise = new Promise(resolve => { completion.resolve = resolve; });
        completions.set(e.requestId, completion);
      });
      cdp.on('Network.requestServedFromCache', e => { const r = records.get(e.requestId); if (r) r.servedFromCache = true; });
      cdp.on('Network.responseReceived', e => {
        const r = records.get(e.requestId); if (!r) return;
        Object.assign(r, { status: e.response.status, fromDiskCache: e.response.fromDiskCache ?? false,
          fromServiceWorker: e.response.fromServiceWorker ?? false, protocol: e.response.protocol });
      });
      cdp.on('Network.loadingFinished', e => {
        const r = records.get(e.requestId); if (r) r.encodedDataLength = e.encodedDataLength;
        completions.get(e.requestId)?.resolve();
      });
      cdp.on('Network.loadingFailed', e => { completions.get(e.requestId)?.resolve(); });
    }
  }
  async function sample(state, url, range) {
    const mark = network.length;
    const result = await page.evaluate(async ({ url, range, tileSize }) => {
      performance.clearResourceTimings();
      const start = performance.now();
      const response = await fetch(url, { headers: range ? { Range: range } : {}, credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (response.status !== (range ? 206 : 200)) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const expected = range ? 512 : tileSize;
      if (response.headers.get('Content-Length') !== String(expected)) { await response.body?.cancel(); throw new Error('Unexpected object size'); }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expected) throw new Error('Truncated cache probe');
      const timingAllowed = response.headers.get('Timing-Allow-Origin')?.split(/\s*,\s*/).some(v => v === '*' || v === location.origin) ?? false;
      const entry = performance.getEntriesByName(url).at(-1);
      return { status: response.status, bytes: bytes.length, elapsedMs: performance.now() - start,
        headers: Object.fromEntries(['content-range', 'cache-control', 'etag', 'cf-cache-status', 'cf-ray', 'age', 'date', 'timing-allow-origin'].map(h => [h, response.headers.get(h)])),
        timingAllowed, resourceTiming: timingAllowed && entry ? { transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, durationMs: entry.duration } : null };
    }, { url, range, tileSize: Number(tile.size) });
    if (range) assert.equal(result.headers['content-range'], `${range.replace('=', ' ')}/${manifest.archive.size}`);
    // Passive CDP is Chromium-only; no request interception or cache disabling.
    const cdp = network.slice(mark);
    await Promise.all(cdp.map(r => completions.get(r.requestId)?.promise));
    const browserCache = engineName === 'chromium' && cdp.length
      ? cdp.some(r => r.fromDiskCache || r.servedFromCache)
        ? cdp.some(r => r.encodedDataLength === undefined) ? 'unknown'
          : cdp.some(r => r.encodedDataLength > 0) ? 'partial (cache plus network)' : 'hit'
        : 'network'
      : result.resourceTiming ? result.resourceTiming.transferSize === 0 && result.resourceTiming.decodedBodySize > 0 ? 'hit' : 'network' : 'unknown';
    const ray = result.headers['cf-ray'];
    const rayObservation = !ray ? 'unavailable' : seenRays.has(ray) ? 'replayed CF-Ray' : 'new CF-Ray';
    if (ray) seenRays.add(ray);
    report.cache.push({ engine: engineName, state, range: range ?? null, result, browserCache, cdp: engineName === 'chromium' ? cdp : null,
      rayObservation,
      caveat: 'CF headers can be replayed by the browser cache. No fresh CDN request is inferred from cached headers.' });
  }
  try {
    await open();
    await sample('empty persistent profile', archive, 'bytes=0-511');
    await sample('identical range', archive, 'bytes=0-511');
    await sample('overlapping range', archive, 'bytes=256-767');
    await sample('first individual object', individual);
    await sample('identical individual object', individual);
    await page.reload();
    await sample('range after reload', archive, 'bytes=0-511');
    await sample('individual after reload', individual);
    await page.close(); await openPage();
    await sample('range after page reopen', archive, 'bytes=0-511');
    await sample('individual after page reopen', individual);
    await context.close(); context = undefined; await open();
    await sample('range after browser process restart', archive, 'bytes=0-511');
    await sample('individual after browser process restart', individual);
  } finally { await context?.close(); }
}

try {
  await mkdir('test-results', { recursive: true });
  report.cors = await checkCDNCors(manifestUrl);
  assert(report.cors.passed, `CORS failed for app origins: ${report.cors.checks.filter(c => !c.passed).map(c => c.origin + ': ' + c.error).join('; ')}`);
  const manifest = JSON.parse(new TextDecoder().decode(await probe(manifestUrl)));
  new TileLoader(manifest, manifestUrl);
  assert.equal(manifest.release, reference.release, 'This runner uses the pinned regional native corpus.');
  assert.equal(manifest.config.sha256, reference.configSha256);
  report.manifest = manifest;
  await check('CDN config and archive header integrity', async () => {
    assert.equal(await sha256(await probe(manifest.config.url)), manifest.config.sha256);
    assert.equal(await sha256(await probe(manifest.archive.url, 'bytes=0-511')), manifest.archive.headerSha256);
    assert.equal(report.probes.at(-1).headers.etag, manifest.archive.etag);
  });
  for (const [engineName, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    report.browsers.push({ engine: engineName, version: browser.version() });
    try {
      for (const transport of ['indexed-tar', 'individual-tiles']) {
        const passed = await check(`${engineName} ${transport}: native corpus and serialized submissions`, async () => {
          const context = await browser.newContext();
          try {
            const page = await setup(context, transport);
            const startup = await page.evaluate(() => window.router.initialize());
            for (const fixture of reference.cases) report.cases.push({ engine: engineName, transport, name: fixture.name, diagnostics: await route(page, fixture) });
            const results = await page.evaluate(request => Promise.all([window.router.route(request), window.router.route(request), window.router.route(request)]), long.request);
            results.forEach(result => assert.deepEqual(result.native, long.expected));
            const session = await page.evaluate(() => window.router.diagnostics());
            const trace = session.trace;
            if (transport === 'indexed-tar') assert(trace.every(r => r.url.endsWith('/graph.tar') && BigInt(r.size) < BigInt(manifest.archive.size)));
            assert((await page.evaluate(() => window.heartbeats)) > 5);
            report.tests.push({ name: 'startup, selective verified downloads and main-thread responsiveness', engine: engineName, transport, passed: true, startup, session });
          } finally { await context.close(); }
        });
        if (!passed) continue;
        await check(`${engineName} ${transport}: five cold / twenty same-worker warm routes`, async () => {
          const cold = [], warm = [];
          for (let i = 0; i < report.sampleCounts.cold; i++) {
            const context = await browser.newContext();
            try {
              const page = await setup(context, transport);
              const startup = await page.evaluate(() => window.router.initialize());
              const diagnostics = await route(page, long);
              assert.equal(diagnostics.loader.tileDownloads, Object.keys(manifest.tiles).length);
              const session = await page.evaluate(() => window.router.diagnostics());
              cold.push({ startup, diagnostics, trace: session.trace });
              if (i === 0) for (let w = 0; w < report.sampleCounts.warm; w++) {
                const metrics = await route(page, long);
                assert.equal(metrics.loader.requests, 0); assert(metrics.decodedCacheHits > 0);
                warm.push(metrics);
              }
            } finally { await context.close(); }
          }
          report.benchmarks.push({ engine: engineName, transport,
            coldState: 'new worker and isolated browser HTTP context per sample; CDN state recorded per response (preceding checks may warm eligible objects; no purge); WASM compilation cache uncontrolled',
            coldHostMs: percentile(cold.map(r => r.startup.workerReadyMs + r.diagnostics.hostRouteMs)),
            warmHostMs: percentile(warm.map(r => r.hostRouteMs)), cold, warm });
        });
      }
      await check(`${engineName}: cancel public archive tile loading and recover`, async () => {
        const context = await browser.newContext();
        try {
          const page = await setup(context, 'indexed-tar');
          await page.evaluate(() => window.router.initialize());
          const cancelled = await page.evaluate(async request => {
            let requested = false;
            window.router.options.onProgress = e => { if (e.phase === 'fetching-tile' && !requested) { requested = true; window.router.cancel(); } };
            try { await window.router.route(request); return { resolved: true }; }
            catch (e) { return { code: e.code, requested }; }
            finally { window.router.options.onProgress = undefined; }
          }, long.request);
          assert.deepEqual(cancelled, { code: 'CANCELLED', requested: true });
          const recovery = await route(page, long);
          report.tests.push({ name: 'public CDN cancellation recovery result', engine: engineName, passed: true, recovery });
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
    await check(`${engineName}: identical/overlapping ranges, reload and browser restart`, () => cacheExperiment(engineName, engine, manifest));
  }
  report.passed = report.tests.every(test => test.passed);
  if (report.passed) await writeFile('public/r2.json', JSON.stringify({ name: 'Liechtenstein 2015 · public R2/CDN',
    manifestUrl, requestsUrl: '/fixtures/region/requests.json' }, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile('test-results/cdn.json', JSON.stringify(report, reportValue, 2) + '\n');
  host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve));
}
