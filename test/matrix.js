import assert from 'node:assert/strict';
import { chromium, firefox, webkit, devices } from 'playwright';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import { createRangeServer } from '../scripts/server.js';
import { startTrace } from './minio-trace.js';

const read = async file => JSON.parse(await readFile(file));
const discovery = await read('public/minio.json');
const corpora = await Promise.all(['fixtures', 'fixtures/region'].map(async dir => ({
  reference: await read(`${dir}/reference.json`), manifest: await read(`${dir}/manifest.json`), dir
})));
const host = createRangeServer({ faults: true });
host.server.listen(0, '127.0.0.1'); await once(host.server, 'listening');
const base = `http://127.0.0.1:${host.server.address().port}`;
const trace = await startTrace();
const report = { at: new Date().toISOString(), device: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem() },
  distribution: 'Direct cross-origin MinIO on loopback; no proxy or CDN',
  browserTransferSizes: null, browserTransferSizeReason: 'MinIO does not provide Timing-Allow-Origin; cross-origin Resource Timing zeros are not evidence of cache hits.',
  cases: [], benchmarks: [], cache: [], tests: [], browsers: [], sampleCounts: { cold: 5, warm: 20 } };
const transports = ['indexed-tar', 'individual-tiles'];
const long = corpora[1].reference.cases.find(c => c.name === 'balzers-ruggell');
const manifestUrl = corpus => discovery.datasets.find(d => d.manifestUrl.includes(`/${corpus.manifest.release}/`)).manifestUrl;

async function setup(context, corpus, transport, delivery = 'minio') {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate(async options => {
    const { Router } = await import('/dist/index.js');
    window.events = [];
    window.router = new Router({ ...options, onProgress: e => window.events.push(e) });
  }, { transport, manifestUrl: delivery === 'minio' ? manifestUrl(corpus) : `${base}/datasets/${corpus.manifest.release}/manifest.json` });
  return page;
}
async function route(page, fixture, corpus) {
  const actual = await page.evaluate(async request => {
    try { return { result: await window.router.route(request) }; }
    catch (e) { return { error: { code: e.code, nativeCode: e.nativeCode, message: e.message } }; }
  }, fixture.request);
  if (fixture.expected.nativeError === 171 && fixture.name === 'outside') assert.equal(actual.error?.code, 'OUTSIDE_COVERAGE');
  else if (fixture.expected.nativeError !== undefined) assert.equal(actual.error?.nativeCode, fixture.expected.nativeError);
  else {
    assert(!actual.error, JSON.stringify(actual.error));
    assert.deepEqual(actual.result.native, fixture.expected, `${fixture.name}: native/browser mismatch`);
    assert.equal(actual.result.dataset.release, corpus.reference.release);
    assert.equal(actual.result.dataset.configSha256, corpus.reference.configSha256);
  }
  return actual.result?.diagnostics;
}
const percentiles = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};

async function cacheExperiment(engineName, engine) {
  const profile = await mkdtemp('test-results/http-profile-');
  const m = corpora[1].manifest, url = manifestUrl(corpora[1]);
  const archive = new URL('graph.tar', url).href;
  const individual = new URL(`tiles/${Object.values(m.tiles)[0].path}`, url).href;
  let context;
  let page;
  async function sample(state, object, range) {
    await trace.flush(); const mark = trace.records.length;
    const result = await page.evaluate(async ({ object, range }) => {
      const started = performance.now();
      const response = await fetch(object, { headers: range ? { Range: range } : {}, credentials: 'omit' });
      const bytes = (await response.arrayBuffer()).byteLength;
      return { status: response.status, contentRange: response.headers.get('Content-Range'), bytes, elapsedMs: performance.now() - started };
    }, { object, range });
    assert.equal(result.status, range ? 206 : 200);
    if (range) assert.equal(result.bytes, 512);
    await trace.flush();
    const records = trace.records.slice(mark).filter(r => r.path === new URL(object).pathname);
    report.cache.push({ engine: engineName, state, range: range ?? null, result, originRequests: records.length,
      originBodyBytes: records.reduce((n, r) => n + r.bodyBytes, 0), originRecords: records });
  }
  try {
    context = await engine.launchPersistentContext(profile, { headless: true });
    page = await context.newPage(); await page.goto(base);
    await sample('empty persistent profile', archive, 'bytes=0-511');
    await sample('identical range', archive, 'bytes=0-511');
    await sample('overlapping range', archive, 'bytes=256-767');
    await sample('first individual object', individual);
    await sample('identical individual object', individual);
    await page.reload();
    await sample('range after reload', archive, 'bytes=0-511');
    await sample('individual after reload', individual);
    await page.close(); page = await context.newPage(); await page.goto(base);
    await sample('range after page reopen', archive, 'bytes=0-511');
    await sample('individual after page reopen', individual);
    await context.close(); context = undefined;
    context = await engine.launchPersistentContext(profile, { headless: true });
    page = await context.newPage(); await page.goto(base);
    await sample('range after browser process restart', archive, 'bytes=0-511');
    await sample('individual after browser process restart', individual);
  } finally { await context?.close(); }
}

try {
  await mkdir('test-results', { recursive: true });
  {
    const url = manifestUrl(corpora[1]);
    const manifest = await (await fetch(url)).json();
    const head = await fetch(new URL('graph.tar', url), { method: 'HEAD', headers: { Origin: base } });
    const headers = Object.fromEntries(['etag', 'content-length', 'cache-control', 'accept-ranges',
      'access-control-allow-origin', 'access-control-expose-headers', 'timing-allow-origin', 'vary']
      .map(name => [name, head.headers.get(name)]));
    assert.equal(head.status, 200);
    assert.equal(headers.etag, manifest.archive.etag);
    assert.equal(headers['content-length'], manifest.archive.size);
    assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(headers['accept-ranges'], 'bytes');
    assert.equal(headers['access-control-allow-origin'], base);
    for (const name of ['content-range', 'etag', 'last-modified']) assert(headers['access-control-expose-headers'].toLowerCase().includes(name));
    assert(!headers.vary.toLowerCase().includes('range'));
    report.tests.push({ name: 'real MinIO HEAD, immutable caching, opaque ETag and CORS headers', passed: true, headers });
  }
  for (const [engineName, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true });
    report.browsers.push({ engine: engineName, version: browser.version() });
    try {
      for (const corpus of corpora) for (const transport of transports) {
        const context = await browser.newContext();
        try {
          const page = await setup(context, corpus, transport);
          const startup = await page.evaluate(() => window.router.initialize());
          for (const fixture of corpus.reference.cases) {
            const diagnostics = await route(page, fixture, corpus);
            report.cases.push({ engine: engineName, transport, release: corpus.manifest.release, name: fixture.name, diagnostics });
          }
          report.tests.push({ engine: engineName, transport, name: `${corpus.dir}: entire native corpus over MinIO`, startup, passed: true });
        } finally { await context.close(); }
      }
      // Real regional graph over the local range server also matches the native reference.
      for (const transport of transports) {
        const context = await browser.newContext();
        try {
          const page = await setup(context, corpora[1], transport, 'local');
          for (const fixture of corpora[1].reference.cases) await route(page, fixture, corpora[1]);
          report.tests.push({ engine: engineName, transport, name: 'regional native corpus over local HTTP', passed: true });
        } finally { await context.close(); }
      }
      {
        const context = await browser.newContext();
        try {
          const page = await setup(context, corpora[1], 'indexed-tar');
          await page.evaluate(() => window.router.initialize());
          const cancelled = await page.evaluate(async request => {
            let requested = false;
            window.router.options.onProgress = event => {
              if (event.phase === 'fetching-tile' && !requested) { requested = true; window.router.cancel(); }
            };
            try { await window.router.route(request); return { resolved: true }; }
            catch (error) { return { code: error.code, requested }; }
            finally { window.router.options.onProgress = undefined; }
          }, long.request);
          assert.deepEqual(cancelled, { code: 'CANCELLED', requested: true });
          const recovery = await route(page, long, corpora[1]);
          report.tests.push({ engine: engineName, name: 'cancel MinIO tile loading and route again', passed: true, recovery });
        } finally { await context.close(); }
      }
      for (const transport of transports) {
        const cold = [], warm = [];
        for (let i = 0; i < report.sampleCounts.cold; i++) {
          const context = await browser.newContext();
          try {
            const page = await setup(context, corpora[1], transport);
            await trace.flush(); const mark = trace.records.length;
            const startup = await page.evaluate(() => window.router.initialize());
            const diagnostics = await route(page, long, corpora[1]);
            assert(diagnostics.loader.tileDownloads >= 2);
            await trace.flush();
            const origin = trace.records.slice(mark).filter(r => r.path.includes(corpora[1].manifest.release));
            assert(origin.some(r => r.method === 'GET'), 'Cold HTTP sample must reach MinIO');
            cold.push({ startup, diagnostics, originRequests: origin.length, originBodyBytes: origin.reduce((n, r) => n + r.bodyBytes, 0) });
            if (i === 0) for (let w = 0; w < report.sampleCounts.warm; w++) {
              const metrics = await route(page, long, corpora[1]);
              assert.equal(metrics.loader.requests, 0);
              assert(metrics.decodedCacheHits > 0);
              warm.push(metrics);
            }
          } finally { await context.close(); }
        }
        report.benchmarks.push({ engine: engineName, transport, release: corpora[1].manifest.release,
          coldState: 'new worker and isolated browser context each sample; actual MinIO origin requests verified; WASM compilation cache uncontrolled; no CDN',
          coldHostMs: percentiles(cold.map(r => r.startup.workerReadyMs + r.diagnostics.hostRouteMs)),
          warmHostMs: percentiles(warm.map(r => r.hostRouteMs)), cold, warm });
      }
      // Mobile browser emulation uses this desktop's CPU and memory; no handset performance claim.
      if (engineName !== 'firefox') {
        const device = engineName === 'chromium' ? 'Pixel 7' : 'iPhone 13';
        const context = await browser.newContext(devices[device]);
        try {
          const page = await setup(context, corpora[1], 'indexed-tar');
          const cold = await route(page, long, corpora[1]);
          const warm = await route(page, long, corpora[1]);
          assert.equal(warm.loader.requests, 0);
          report.tests.push({ engine: engineName, name: `${device} viewport/touch emulation on desktop`, passed: true, cold, warm });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
    await cacheExperiment(engineName, engine);
    console.log(`PASS ${engineName}: MinIO and local corpora, regional benchmark, browser restart cache experiment`);
  }
  await trace.flush();
  const archives = trace.records.filter(r => r.method === 'GET' && r.path.endsWith('/graph.tar'));
  assert(archives.length > 0);
  const cancelled = archives.filter(r => r.status === 499);
  const completed = archives.filter(r => r.status !== 499);
  assert(completed.every(r => r.status === 206 && r.range && r.contentRange), 'MinIO must never deliver a whole archive GET');
  for (const r of archives) {
    const corpus = corpora.find(c => r.path === `/valhalla/datasets/${c.manifest.release}/graph.tar`);
    assert(corpus, 'Archive request must belong to a pinned dataset');
    const size = BigInt(corpus.manifest.archive.size);
    const range = /^bytes=(\d+)-(\d+)$/.exec(r.range ?? '');
    assert(range, 'Every archive GET, including cancellation, must request an explicit range');
    const start = BigInt(range[1]), end = BigInt(range[2]);
    assert(start <= end && end < size && end - start + 1n < size);
    assert(Number.isSafeInteger(r.bodyBytes) && r.bodyBytes >= 0);
    assert(BigInt(r.bodyBytes) < size, 'Origin must never transfer a whole archive body');
    if (r.status === 206) {
      assert.equal(r.contentRange, `bytes ${start}-${end}/${size}`);
      assert.equal(BigInt(r.bodyBytes), end - start + 1n, 'Completed transfer must equal the requested range');
    }
    // A worker-aborted request can record a partial transfer or MinIO error reply.
    // Its transport byte counter is not necessarily zero; 499 is never accepted by the loader.
  }
  report.tests.push({ name: 'MinIO origin trace: every completed archive GET is selective 206', passed: true,
    archiveRequests: completed.length, cancelledRequests: cancelled.length });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; throw error;
} finally {
  report.originRecords = trace.records;
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/matrix.json', JSON.stringify(report, null, 2) + '\n');
  trace.stop(); host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve));
}
