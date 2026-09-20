import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { Router } from '../packages/valhalla-server/dist/node.js';
import { corpora, host, report } from './server-support.js';
import { cloudflareHarness } from './server-cloudflare-support.js';

const data = await corpora(); const corpus = data[1]; const server = await host();
const results = { dataset: corpus.manifest, samples: [], artifacts: {}, passed: false,
  conditions: 'Loopback HTTP or real local Miniflare R2; no CDN/browser HTTP cache. Five fresh actor sessions per profile/backend; twenty repeated routes in the fifth session. Node sessions use fresh threads. Cloudflare sessions share an isolate/static compiled module; isolate/compilation cold-start is not measured. All wall timing uses the external Node clock. WASM capacity excludes JS/RSS. No concurrent benchmark workloads.',
};
{
  const bytes = await readFile('public/wasm/valhalla.wasm');
  results.artifacts.shared = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}
let cf;
try {
  cf = await cloudflareHarness(server, data); results.versions = cf.versions;
  for (const runtime of ['node', 'cloudflare']) for (const source of runtime === 'node' ? ['http'] : ['http', 'r2'])
    for (const transport of ['indexed-tar', 'individual-tiles']) for (const costing of ['auto', 'bicycle', 'pedestrian', 'truck']) {
      const fixture = corpus.reference.cases.find(c => c.name === `balzers-ruggell${costing === 'auto' ? '' : '-' + costing}`);
      const entry = { runtime, source, transport, costing, cold: [], warm: [] }; results.samples.push(entry);
      for (let sample = 0; sample < 5; sample++) {
        let router;
        try {
          if (runtime === 'node') router = new Router({ manifestUrl: `${server.base}/datasets/${corpus.manifest.release}/manifest.json`, transport });
          else await cf.reset(corpus, source, { transport });
          const started = performance.now();
          const startup = router ? await router.initialize() : await cf.call({ command: 'initialize' });
          const startupWallMs = performance.now() - started;
          const route = () => router ? router.route(fixture.request) : cf.route(fixture.request);
          const begin = performance.now(); const result = await route();
          assert.deepEqual(result.native, fixture.expected);
          entry.cold.push({ startupWallMs, routeWallMs: performance.now() - begin, startup, diagnostics: result.diagnostics });
          if (sample === 4) for (let repeat = 0; repeat < 20; repeat++) {
            const begin = performance.now(); const result = await route();
            assert.deepEqual(result.native, fixture.expected); assert.equal(result.diagnostics.loader.tileDownloads, 0);
            entry.warm.push({ routeWallMs: performance.now() - begin, diagnostics: result.diagnostics });
          }
        } finally { await router?.dispose(); }
      }
      const median = values => { const sorted = values.toSorted((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
      entry.medians = { startupWallMs: median(entry.cold.map(s => s.startupWallMs)), coldRouteWallMs: median(entry.cold.map(s => s.routeWallMs)), warmRouteWallMs: median(entry.warm.map(s => s.routeWallMs)) };
      console.log(`${runtime}/${source}/${transport}/${costing}: ${JSON.stringify(entry.medians)}`);
    }
  results.passed = true;
} finally { await cf?.mf.dispose(); await server.close(); await report('server-benchmark', results); }
