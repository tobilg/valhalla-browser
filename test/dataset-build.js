// Build a fresh SDK release from the pinned OSM PBF, then compare real WASM routes
// with freshly computed native results. Requires build:native, data:region and build:sdk.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { root, execute, readJSON, listen, closeHost, routeProof, writeReport, device } from './package-support.js';

await mkdir(path.join(root, 'build'), { recursive: true });
await mkdir(path.join(root, 'public/datasets'), { recursive: true });
const work = await mkdtemp(path.join(root, 'build/osm-verification-'));
const delivery = await mkdtemp(path.join(root, 'public/datasets/osm-verification-'));
const relative = file => path.relative(root, file);
const report = { at: new Date().toISOString(), device: device(), workDir: relative(work), runs: [], passed: false };
try {
  await execute('bash', ['scripts/build-dataset.sh',
    '--pbf', 'build/sources/valhalla/test/data/liechtenstein-latest.osm.pbf',
    '--timezone-db', 'build/region/timezones.sqlite',
    '--name', 'osm-build-proof', '--bbox=9.471078,47.047740,9.636217,47.271280',
    '--work-dir', relative(path.join(work, 'native')), '--output', relative(delivery),
  ], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const build = await readJSON(path.join(work, 'native/build-report.json'));
  report.build = build;
  const manifest = await readJSON(path.join(delivery, build.release, 'manifest.json'));
  const requests = await readJSON(path.join(root, 'fixtures/region/requests.json'));
  const { stdout } = await execute('docker', ['run', '--rm', '-v', `${root}:/work`, '-w', '/work',
    'valhalla-browser-build', 'build/native/native-reference',
    relative(path.join(work, 'native/native-config.json')), 'fixtures/region/requests.jsonl',
  ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const results = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(results.length, requests.length);
  const reference = { release: manifest.release, cases: requests.map((item, i) => ({ ...item, expected: results[i] })) };
  assert(reference.cases.some(item => item.expected.trip), 'Native routing must produce a real route');
  const host = createRangeServer();
  const base = await listen(host);
  try {
    const browser = await chromium.launch();
    report.browser = browser.version();
    try {
      for (const transport of ['indexed-tar', 'individual-tiles']) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(base);
          await page.evaluate(async () => { window.sdk = await import('/dist/index.js'); });
          const start = host.records.length;
          const result = await routeProof(page, {
            manifestUrl: `${base}/datasets/${path.basename(delivery)}/${manifest.release}/manifest.json`,
            reference, transport,
          });
          for (const item of reference.cases.filter(item => item.expected.trip)) {
            const native = await page.evaluate(async request => (await window.router.route(request)).native, item.request);
            assert.deepEqual(native, item.expected, `${transport}: ${item.name}`);
          }
          const transfers = host.records.slice(start);
          const archiveGets = transfers.filter(item => item.path.endsWith('/graph.tar') && item.method === 'GET');
          if (transport === 'indexed-tar') {
            assert(archiveGets.length >= 3);
            assert(archiveGets.every(item => item.status === 206 && item.range && item.bodyBytes < Number(manifest.archive.size)));
          } else assert.equal(archiveGets.length, 0);
          report.runs.push({ transport, ...result, transfers, passed: true });
          await page.evaluate(() => window.router.dispose());
          console.log(`PASS OSM build → ${transport}: exact native routes and same-worker cache reuse`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await closeHost(host); }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stderr: error.stderr ?? null };
  throw error;
} finally {
  // Only the temporary delivery directory created by this test is removed.
  // Native graph/config/build reports remain under the printed workDir for inspection.
  await rm(delivery, { recursive: true, force: true });
  await writeReport('dataset-build', report);
}
