import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';

const read = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaults = { astar: 16384, bidirectionalAstar: 16384, clearReservedMemory: false };
const legacy = { astar: 2000000, bidirectionalAstar: 1000000, clearReservedMemory: false };
const corpora = await Promise.all(['fixtures', 'fixtures/region'].map(async dir => {
  const manifest = await read(`${dir}/manifest.json`);
  return { manifest, reference: await read(`${dir}/reference.json`), config: await read(`public/datasets/${manifest.release}/config.json`) };
}));
const engine = process.env.BROWSER ?? 'chromium';
const launcher = { chromium, firefox, webkit }[engine];
assert(launcher, `Unknown BROWSER: ${engine}`);
const host = createRangeServer();
host.server.listen(0, 'localhost'); await once(host.server, 'listening');
const base = `http://localhost:${host.server.address().port}`;
const browser = await launcher.launch();
const report = { at: new Date().toISOString(), engine, browser: browser.version(),
  device: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem() },
  runtime: await read('native/runtime-lock.json'),
  delivery: 'Loopback HTTP; no CDN. Fresh browser contexts/workers for cold samples; WASM compilation cache uncontrolled.',
  memoryMetric: 'Allocated WASM linear-memory capacity, not live allocations, JS memory or RSS.',
  summaryConvention: 'Median: midpoint for even counts; p95: nearest rank.',
  cases: [], tests: [], benchmarks: [], passed: false };

async function setup(corpus, searchMemory, transport = 'indexed-tar', initialize = true) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base);
    const manifestUrl = `${base}/datasets/${corpus.manifest.release}/manifest.json`;
    await page.evaluate(async options => {
      const { Router } = await import('/dist/index.js');
      window.router = new Router(options);
    }, { manifestUrl, searchMemory, transport });
    const startup = initialize ? await page.evaluate(() => window.router.initialize()) : undefined;
    if (startup) {
      assert.deepEqual(startup.searchMemory, { ...defaults, ...searchMemory });
      assert.equal(startup.configSha256, corpus.manifest.config.sha256);
      const effective = structuredClone(corpus.config);
      effective.mjolnir.tile_url = transport === 'indexed-tar'
        ? new URL(corpus.manifest.archive.url, manifestUrl).href
        : new URL('tiles/{tilePath}', manifestUrl).href.replace('%7BtilePath%7D', '{tilePath}');
      Object.assign(effective.mjolnir, { max_cache_size: 32 * 1024 * 1024, use_lru_mem_cache: true,
        lru_mem_cache_hard_control: true, global_synchronized_cache: false });
      Object.assign(effective.thor, { max_reserved_labels_count_astar: startup.searchMemory.astar,
        max_reserved_labels_count_bidir_astar: startup.searchMemory.bidirectionalAstar,
        clear_reserved_memory: startup.searchMemory.clearReservedMemory });
      assert.equal(startup.effectiveConfigSha256, hash(effective));
    }
    return { context, page, startup };
  } catch (error) { await context.close(); throw error; }
}

async function route(page, fixture, corpus) {
  const actual = await page.evaluate(async request => {
    try { return { result: await window.router.route(request) }; }
    catch (e) { return { error: { code: e.code, nativeCode: e.nativeCode, message: e.message } }; }
  }, fixture.request);
  if (fixture.expected.nativeError === 171 && fixture.name.startsWith('outside')) assert.equal(actual.error?.code, 'OUTSIDE_COVERAGE');
  else if (fixture.expected.nativeError !== undefined) assert.equal(actual.error?.nativeCode, fixture.expected.nativeError);
  else {
    assert(!actual.error, JSON.stringify(actual));
    assert.deepEqual(actual.result.native, fixture.expected, fixture.name);
    assert.equal(actual.result.dataset.configSha256, corpus.manifest.config.sha256);
    assert.equal(actual.result.dataset.effectiveConfigSha256, await page.evaluate(() => window.router.startup.effectiveConfigSha256));
  }
  return actual;
}
const longRoute = (corpus, costing = 'auto') => corpus.reference.cases.find(c =>
  c.name === (corpus === corpora[0] ? 'cross-tile' : 'balzers-ruggell') + (costing === 'auto' ? '' : `-${costing}`));
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};

try {
  const variants = [
    { name: 'defaults', options: undefined },
    { name: 'grow-from-zero', options: { astar: 0, bidirectionalAstar: 0 } },
    { name: 'clear-after-route', options: { clearReservedMemory: true } },
    { name: 'independent-overrides', options: { astar: 4096, bidirectionalAstar: 65536 } },
  ];
  for (const variant of variants) for (const corpus of corpora) for (const transport of ['indexed-tar', 'individual-tiles']) {
    const { context, page, startup } = await setup(corpus, variant.options, transport);
    try {
      const results = [];
      for (const fixture of corpus.reference.cases) {
        const actual = await route(page, fixture, corpus);
        results.push({ name: fixture.name, error: actual.error, diagnostics: actual.result?.diagnostics });
      }
      const repeated = await route(page, longRoute(corpus), corpus);
      assert.equal(repeated.result.diagnostics.loader.requests, 0, 'Search-vector cleanup must retain decoded tiles');
      const diagnostics = await page.evaluate(() => window.router.diagnostics());
      assert.equal(diagnostics.native.wasmHeapCapacityHighWaterBytes, 128 * 1024 * 1024, 'These fixed corpora should stay within the initial WASM allocation');
      report.cases.push({ variant: variant.name, release: corpus.manifest.release, transport, startup, results, native: diagnostics.native });
      console.log(`PASS search memory: ${engine} ${variant.name} ${transport} ${corpus.reference.cases.length} native cases (${corpus.manifest.release})`);
    } finally { await context.close(); }
  }

  const corpus = corpora[1];
  const { context, page } = await setup(corpus, { bidirectionalAstar: -1 }, 'indexed-tar', false);
  try {
    const mark = host.records.length;
    assert.equal(await page.evaluate(() => window.router.initialize().then(() => null, e => e.code)), 'INVALID_REQUEST');
    assert(!host.records.slice(mark).some(r => r.path.startsWith('/datasets/') || r.path.endsWith('.wasm')), 'Invalid reservations reject before dataset/WASM downloads');
    await page.evaluate(() => { window.router.options.searchMemory = { astar: 4096, bidirectionalAstar: 8192, clearReservedMemory: true }; });
    await route(page, longRoute(corpus), corpus);
    assert.deepEqual(await page.evaluate(() => window.router.startup.searchMemory), { astar: 4096, bidirectionalAstar: 8192, clearReservedMemory: true });
    const firstHash = await page.evaluate(() => window.router.startup.effectiveConfigSha256);
    await page.evaluate(() => {
      window.router.cancel();
      window.router.options.onProgress = event => { if (event.phase === 'fetching-tile') window.router.cancel(); };
    });
    assert.equal((await page.evaluate(async request => {
      try { await window.router.route(request); return null; }
      catch (e) { return e.code; }
      finally { window.router.options.onProgress = undefined; }
    }, longRoute(corpus).request)), 'CANCELLED');
    await route(page, longRoute(corpus), corpus);
    assert.equal(await page.evaluate(() => window.router.startup.effectiveConfigSha256), firstHash);
    report.tests.push('Invalid initialization recovers; non-default settings survive cancellation and a subsequent real route');
  } finally { await context.close(); }

  if (process.argv.includes('--benchmark')) {
    for (const [name, options] of [['legacy', legacy], ['defaults', undefined]]) {
      for (const costing of ['auto', 'bicycle', 'pedestrian', 'truck']) {
        const samples = [];
        for (let i = 0; i < 5; i++) {
          const { context, page, startup } = await setup(corpus, options);
          try {
            const cold = (await route(page, longRoute(corpus, costing), corpus)).result.diagnostics;
            const warm = [];
            if (i === 4) for (let j = 0; j < 20; j++) {
              const result = (await route(page, longRoute(corpus, costing), corpus)).result;
              assert.equal(result.diagnostics.loader.requests, 0);
              warm.push(result.diagnostics);
            }
            samples.push({ startup, cold, warm });
          } finally { await context.close(); }
        }
        const entry = { variant: name, costing, release: corpus.manifest.release, samples,
          coldRouteMs: summary(samples.map(s => s.cold.routeMs)), warmRouteMs: summary(samples.flatMap(s => s.warm.map(w => w.routeMs))),
          heapCapacityHighWaterBytes: Math.max(...samples.flatMap(s => [s.cold, ...s.warm]).map(s => s.native.wasmHeapCapacityHighWaterBytes)) };
        report.benchmarks.push(entry);
        console.log(`BENCH ${engine} ${name} ${costing}: ${entry.heapCapacityHighWaterBytes / 1048576} MiB; cold/warm route medians ${entry.coldRouteMs.median}/${entry.warmRouteMs.median} ms`);
      }
    }
  }
  const archives = host.records.filter(r => r.path.endsWith('graph.tar') && r.method === 'GET');
  assert(archives.length > 0);
  assert(archives.every(r => r.status === 206 && r.range && r.bodyBytes < Number(corpora.find(c => r.path.includes(c.manifest.release)).manifest.archive.size)));
  report.selectiveArchiveRequests = archives.length;
  report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/search-memory-${engine}.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close(); host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve));
}
