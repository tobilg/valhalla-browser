import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createModule from '../public/wasm/valhalla.js';
import { probeMemory, instantiateTestRuntime } from './wasm-memory-probe.js';
import { Router } from '../packages/valhalla-server/dist/node.js';
import { corpora, host, longRoute, equivalent, typed, report } from './server-support.js';

const data = await corpora();
const server = await host();
const results = { tests: [], comparisons: 0, passed: false };
const options = (corpus = data[1]) => ({ manifestUrl: `${server.base}/datasets/${corpus.manifest.release}/manifest.json`, retries: 0, queueTimeoutMs: 10000 });
try {
  const compiled = await WebAssembly.compile(await readFile('public/wasm/valhalla.wasm'));
  assert.equal(WebAssembly.Module.imports(compiled).filter(i => i.kind === 'memory').length, 1);
  results.memory = [];
  for (const maximumMiB of [64, 80, 96, 128]) results.memory.push(await probeMemory(createModule, compiled, 64, maximumMiB));
  const ceiling = await instantiateTestRuntime(createModule, compiled, 64, 1024);
  assert.equal(ceiling.memory.buffer.byteLength, 64 * 1048576);
  assert.equal(JSON.parse(ceiling.runtime.ccall('vb_stats', 'string', [], [])).abi, 3);
  await assert.rejects(instantiateTestRuntime(createModule, compiled, 64, 1025), WebAssembly.LinkError);
  results.tests.push({ name: 'compiled-1024-MiB-ceiling-does-not-preallocate-maximum' });
  for (const corpus of data) for (const transport of ['indexed-tar', 'individual-tiles']) {
    const router = new Router({ ...options(corpus), transport });
    try {
      const startup = await router.initialize();
      assert.equal(startup.native.abi, 3);
      assert.deepEqual(startup.wasmMemory, { initialMiB: 256, maximumMiB: 512 });
      assert.equal(startup.native.wasmHeapCapacityHighWaterBytes, 256 * 1048576);
      for (const fixture of corpus.reference.cases) { await equivalent(request => router.route(request), fixture); results.comparisons++; }
      const repeated = await equivalent(request => router.route(request), longRoute(corpus));
      assert.equal(repeated.diagnostics.loader.tileDownloads, 0);
      assert(repeated.diagnostics.decodedCacheHits > 0);
      const diagnostics = await router.diagnostics();
      assert(diagnostics.native.decodedCacheBytes <= startup.memoryBudgetBytes);
      results.tests.push({ name: `${corpus.manifest.release}/${transport}`, startup, diagnostics });
    } finally { await router.dispose(); }
  }
  {
    const router = new Router({ ...options(data[0]), wasmMemory: { initialMiB: 72, maximumMiB: 80 }, searchMemory: { bidirectionalAstar: 1000000 } });
    try {
      const startup = await router.initialize();
      assert.deepEqual(startup.wasmMemory, { initialMiB: 72, maximumMiB: 80 });
      assert.equal(startup.native.wasmHeapCapacityHighWaterBytes, 72 * 1048576);
      await assert.rejects(router.route(longRoute(data[0]).request), typed('RESOURCE_LIMIT'));
      await equivalent(request => router.route(request), data[0].reference.cases.find(c => c.name === 'short'));
      assert.deepEqual(router.startup.wasmMemory, { initialMiB: 72, maximumMiB: 80 });
      results.tests.push({ name: 'custom-imported-memory-allocation-failure-and-thread-replacement' });
    } finally { await router.dispose(); }
  }
  const fixture = longRoute(data[1]);
  for (const [fault, code] of [['ignore-range', 'RANGE_UNSUPPORTED'], ['wrong-range', 'INVALID_RANGE'], ['mismatch', 'DATASET_MISMATCH'],
    ['corrupt', 'CORRUPT_TILE'], ['missing', 'INCOMPLETE_DATASET'], ['transient', 'NETWORK'], ['truncated', 'TIMEOUT']]) {
    const router = new Router({ ...options(), timeoutMs: 300 });
    try {
      await router.initialize();
      server.setFault({ type: fault, tileOnly: true });
      await assert.rejects(router.route(fixture.request), typed(code));
      await equivalent(request => router.route(request), fixture);
      results.tests.push({ name: `fault-${fault}-recovery` });
    } finally { server.setFault(null); await router.dispose(); }
  }
  {
    const router = new Router(options());
    try {
      server.setFault({ type: 'transient', match: 'manifest.json' });
      await assert.rejects(router.initialize(), typed('NETWORK'));
      await equivalent(request => router.route(request), fixture);
      results.tests.push({ name: 'initialization-failure-recovery' });
    } finally { await router.dispose(); }
  }
  {
    const router = new Router({ ...options(), maxQueuedRoutes: 2, queueTimeoutMs: 10000 });
    try {
      await router.initialize();
      server.setFault({ type: 'delay', tileOnly: true, delayMs: 300 });
      const active = router.route(fixture.request);
      const controller = new AbortController();
      const queuedAbort = assert.rejects(router.route(fixture.request, { signal: controller.signal }), typed('CANCELLED'));
      const queued = router.route(fixture.request);
      await assert.rejects(router.route(fixture.request), typed('QUEUE_FULL'));
      controller.abort();
      const [a, b] = await Promise.all([active, queued]); await queuedAbort;
      assert.deepEqual(a.native, b.native); assert.equal(b.diagnostics.loader.tileDownloads, 0);
      results.tests.push({ name: 'serialized-concurrency-queue-overflow-queued-abort' });
    } finally { await router.dispose(); }
  }
  {
    const router = new Router({ ...options(), queueTimeoutMs: 30 });
    try {
      await router.initialize(); server.setFault({ type: 'delay', tileOnly: true, delayMs: 150 });
      const active = router.route(fixture.request);
      await assert.rejects(router.route(fixture.request), typed('QUEUE_TIMEOUT')); await active;
      results.tests.push({ name: 'queue-deadline' });
    } finally { await router.dispose(); }
  }
  {
    const router = new Router({ ...options(), routeTimeoutMs: 2000 });
    try {
      await router.initialize(); server.setFault({ type: 'delay', tileOnly: true, delayMs: 2500 });
      await assert.rejects(router.route(fixture.request), typed('TIMEOUT'));
      await equivalent(request => router.route(request), fixture);
      results.tests.push({ name: 'overall-deadline-thread-replacement-recovery' });
    } finally { await router.dispose(); }
  }
  {
    const controller = new AbortController();
    let cancelOnRouting = false;
    const router = new Router({ ...options(), onProgress(event) { if (cancelOnRouting && event.phase === 'routing') controller.abort(); } });
    try {
      await equivalent(request => router.route(request), fixture);
      cancelOnRouting = true;
      const interrupted = assert.rejects(router.route(fixture.request, { signal: controller.signal }), typed('CANCELLED'));
      const next = router.route(fixture.request);
      await interrupted; cancelOnRouting = false;
      assert.deepEqual((await next).native, fixture.expected);
      assert(router.startup); results.tests.push({ name: 'active-thread-termination-queued-recovery' });
      await router.cancel(); await equivalent(request => router.route(request), fixture);
      await router.dispose(); await assert.rejects(router.route(fixture.request), typed('DISPOSED'));
    } finally { await router.dispose(); }
  }
  assert(server.records.filter(r => r.path.endsWith('graph.tar') && r.method === 'GET' && !r.fault).every(r => r.range && r.status === 206));
  results.passed = true;
  console.log(`PASS Node: ${results.comparisons} exact native comparisons and ${results.tests.length} transport/lifecycle checks`);
} finally { await server.close(); await report('server-node', results); }
