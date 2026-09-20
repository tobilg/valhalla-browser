import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { corpora, host, longRoute, equivalent, typed, report } from './server-support.js';
import { cloudflareHarness } from './server-cloudflare-support.js';

const server = await host();
const data = await corpora();
const { mf, bucket, call, reset, route, versions } = await cloudflareHarness(server, data);
const results = { ...versions, comparisons: 0, tests: [], passed: false };
try {
  results.memory = [];
  for (const maximumMiB of [80, 96]) results.memory.push(await call({ command: 'memory-probe', initialMiB: 64, maximumMiB }));
  await reset(data[0], 'r2', { wasmMemory: { initialMiB: 72, maximumMiB: 80 } });
  const customMemory = await call({ command: 'initialize' });
  assert.deepEqual(customMemory.wasmMemory, { initialMiB: 72, maximumMiB: 80 });
  assert.equal(customMemory.native.wasmHeapCapacityHighWaterBytes, 72 * 1048576);
  await equivalent(route, data[0].reference.cases.find(c => c.name === 'short'));
  results.tests.push({ name: 'configurable-imported-memory-and-native-hard-cap' });
  for (const corpus of data) for (const source of ['http', 'r2']) for (const transport of ['indexed-tar', 'individual-tiles']) {
    await reset(corpus, source, { transport });
    const startup = await call({ command: 'initialize' });
    assert.deepEqual(startup.wasmMemory, { initialMiB: 64, maximumMiB: 96 });
    assert.equal(startup.native.abi, 3); assert.equal(startup.moduleStartupMs, null); assert.equal(startup.loader.sequentialWaitMs, null);
    for (const fixture of corpus.reference.cases) { await equivalent(route, fixture); results.comparisons++; }
    const repeated = await equivalent(route, longRoute(corpus));
    assert.equal(repeated.diagnostics.loader.tileDownloads, 0); assert(repeated.diagnostics.decodedCacheHits > 0);
    const diagnostics = await call({ command: 'diagnostics' });
    assert(diagnostics.cooperativeCheckpoints > 0);
    assert(diagnostics.native.decodedCacheBytes <= startup.memoryBudgetBytes);
    assert.equal(diagnostics.resourceTiming, null); assert(diagnostics.trace.every(t => t.elapsedMs === null));
    results.tests.push({ name: `${corpus.manifest.release}/${source}/${transport}`, startup, diagnostics });
  }
  const fixture = longRoute(data[1]);
  for (const [fault, code] of [['ignore-range', 'RANGE_UNSUPPORTED'], ['wrong-range', 'INVALID_RANGE'], ['mismatch', 'DATASET_MISMATCH'],
    ['corrupt', 'CORRUPT_TILE'], ['missing', 'INCOMPLETE_DATASET'], ['transient', 'NETWORK'], ['truncated', 'TIMEOUT']]) {
    await reset(data[1], 'http', { timeoutMs: 300 }); await call({ command: 'initialize' });
    server.setFault({ type: fault, tileOnly: true });
    await assert.rejects(route(fixture.request), typed(code));
    server.setFault(null); await equivalent(route, fixture);
    results.tests.push({ name: `http-${fault}-recovery` });
  }
  await reset(data[1]); server.setFault({ type: 'transient', match: 'manifest.json' });
  await assert.rejects(call({ command: 'initialize' }), typed('NETWORK')); await equivalent(route, fixture);
  results.tests.push({ name: 'initialization-failure-recovery' });
  await reset(data[1], 'http', { maxQueuedRoutes: 2, queueTimeoutMs: 10000 }); await call({ command: 'initialize' });
  server.setFault({ type: 'delay', tileOnly: true, delayMs: 400 });
  const active = route(fixture.request);
  // Separate dispatches deliberately exercise distinct workerd request contexts.
  await new Promise(resolve => setTimeout(resolve, 30));
  const aborted = assert.rejects(call({ command: 'route', request: fixture.request, abortMs: 50 }), typed('CANCELLED'));
  const queued = route(fixture.request);
  await assert.rejects(route(fixture.request), typed('QUEUE_FULL'));
  const [a, b] = await Promise.all([active, queued]); await aborted;
  assert.deepEqual(a.native, b.native); assert.equal(b.diagnostics.loader.tileDownloads, 0);
  results.tests.push({ name: 'cross-request-context-queue-overflow-queued-abort' });
  for (const source of ['http', 'r2']) {
    await reset(data[1], source); await equivalent(route, fixture);
    const before = await call({ command: 'diagnostics' });
    await assert.rejects(call({ command: 'route', request: fixture.request, abortAtCheckpoint: true }), typed('CANCELLED'));
    const after = await call({ command: 'diagnostics' });
    assert(after.cooperativeCheckpoints > before.cooperativeCheckpoints, 'Cancellation must enter a native Asyncify checkpoint.');
    assert.equal(after.metrics.requests, before.metrics.requests, 'Warm CPU cancellation must not depend on tile I/O.');
    await equivalent(route, fixture);
    results.tests.push({ name: `${source}-warm-native-cooperative-cancel-recovery` });
  }
  // A real R2 precondition failure must never become an authoritative missing tile.
  await reset(data[1], 'r2'); await call({ command: 'initialize' });
  const key = `datasets/${data[1].manifest.release}/graph.tar`;
  const original = await readFile(`public/${key}`);
  await bucket.put(key, new Uint8Array(original.length));
  await assert.rejects(route(fixture.request), typed('DATASET_MISMATCH'));
  await bucket.put(key, original); await equivalent(route, fixture);
  results.tests.push({ name: 'r2-conditional-read-mismatch-recovery' });
  await reset(data[1], 'http', { queueTimeoutMs: 30 }); await call({ command: 'initialize' });
  server.setFault({ type: 'delay', tileOnly: true, delayMs: 200 });
  const running = route(fixture.request);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(route(fixture.request), typed('QUEUE_TIMEOUT')); await running;
  results.tests.push({ name: 'queue-deadline' });
  await reset(data[1]); await call({ command: 'initialize' });
  server.setFault({ type: 'delay', tileOnly: true, delayMs: 300 });
  await assert.rejects(call({ command: 'route', request: fixture.request, abortMs: 50 }), typed('CANCELLED'));
  await equivalent(route, fixture); results.tests.push({ name: 'suspended-http-abort-recovery' });
  await reset(data[1], 'http', { routeTimeoutMs: 2000 }); await call({ command: 'initialize' });
  server.setFault({ type: 'delay', tileOnly: true, delayMs: 2500 });
  await assert.rejects(route(fixture.request), typed('TIMEOUT')); await equivalent(route, fixture);
  results.tests.push({ name: 'overall-operation-deadline-recovery' });
  await reset(data[1], 'r2'); await call({ command: 'initialize' }); await bucket.delete(key);
  await assert.rejects(route(fixture.request), typed('INCOMPLETE_DATASET'));
  await bucket.put(key, original); await equivalent(route, fixture);
  results.tests.push({ name: 'r2-authoritative-absence-recovery' });
  const manifestKey = `datasets/${data[1].manifest.release}/manifest.json`;
  const savedManifest = await (await bucket.get(manifestKey)).text();
  for (const [mutation, code] of [[{ valhallaRevision: 'wrong' }, 'INCOMPATIBLE_DATASET'],
    [{ config: { ...data[1].manifest.config, url: '../config.json' } }, 'DATASET']]) {
    await reset(data[1], 'r2');
    await bucket.put(manifestKey, JSON.stringify({ ...JSON.parse(savedManifest), ...mutation }));
    await assert.rejects(call({ command: 'initialize' }), typed(code));
    await bucket.put(manifestKey, savedManifest); await equivalent(route, fixture);
    results.tests.push({ name: `r2-manifest-${code}-initialization-recovery` });
  }
  // Exceed the actual 96 MiB WASM ceiling, then let the same Router replace its
  // poisoned runtime. The short fixture uses unidirectional A*, which fits.
  await reset(data[0], 'r2', { searchMemory: { bidirectionalAstar: 1000000 } });
  await assert.rejects(route(longRoute(data[0]).request), typed('RESOURCE_LIMIT'));
  await equivalent(route, data[0].reference.cases.find(c => c.name === 'short'));
  assert.equal((await call({ command: 'diagnostics' })).native.wasmHeapCapacityHighWaterBytes, 67108864);
  results.tests.push({ name: 'real-wasm-allocation-failure-runtime-replacement-recovery' });
  await reset(data[1], 'r2', { r2DelayMs: 100, queueTimeoutMs: 10 });
  await call({ command: 'initialize' });
  const disposingRoute = assert.rejects(route(fixture.request), typed('CANCELLED'));
  await new Promise(resolve => setTimeout(resolve, 30));
  await Promise.all([call({ command: 'dispose' }), call({ command: 'dispose' }), disposingRoute]);
  await assert.rejects(route(fixture.request), typed('DISPOSED'));
  await reset(data[1], 'r2'); await equivalent(route, fixture);
  results.tests.push({ name: 'uncancellable-r2-read-settlement-and-repeated-disposal' });
  assert(server.records.filter(r => r.path.endsWith('graph.tar') && r.method === 'GET' && !r.fault).every(r => r.range && r.status === 206));
  results.passed = true;
  console.log(`PASS workerd: ${results.comparisons} exact native comparisons, HTTP + real R2 binding, ${results.tests.length} checks`);
} finally { await mf.dispose(); await server.close(); await report('server-cloudflare', results); }
