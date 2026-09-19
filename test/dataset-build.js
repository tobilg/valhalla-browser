// Build a fresh dataset from the pinned OSM PBF, then compare real WASM routes
// with freshly computed native results. The default runs both phases locally;
// CI hands --prepare's portable bundle to --verify on a separate browser runner.
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { root, execute, readJSON, listen, closeHost, routeProof, writeReport, device } from './package-support.js';

const [phase, bundleArgument, ...extra] = process.argv.slice(2);
assert(!phase || (['--prepare', '--verify'].includes(phase) && bundleArgument && !extra.length),
  'Usage: node test/dataset-build.js [--prepare|--verify bundle-directory]');
const bundle = bundleArgument && path.resolve(root, bundleArgument);
await mkdir(path.join(root, 'build'), { recursive: true });
await mkdir(path.join(root, 'public/datasets'), { recursive: true });
const delivery = await mkdtemp(path.join(root, 'public/datasets/osm-verification-'));
const relative = file => path.relative(root, file);
const report = { at: new Date().toISOString(), device: device(), phase: phase?.slice(2) ?? 'complete', runs: [], passed: false };

async function prepare() {
  const work = await mkdtemp(path.join(root, 'build/osm-verification-'));
  report.workDir = relative(work);
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
  return { schema: 1, build, reference, workDir: relative(work), nativeDevice: device() };
}

async function verify(proof) {
  const { build, reference } = proof;
  assert.equal(proof.schema, 1, 'Unsupported OSM proof bundle');
  assert.match(build.release, /^[a-zA-Z0-9_-]+$/, 'Invalid dataset release');
  const manifest = await readJSON(path.join(delivery, build.release, 'manifest.json'));
  assert.equal(manifest.release, build.release);
  assert.equal(reference.release, build.release);
  assert(reference.cases.some(item => item.expected.trip), 'Native reference must include routes');
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
}

try {
  let proof;
  if (phase === '--verify') {
    proof = await readJSON(path.join(bundle, 'proof.json'));
    // Recreate only the static delivery tree. No native executable, Docker image,
    // source checkout or original builder working directory is needed here.
    assert.match(proof.build.release, /^[a-zA-Z0-9_-]+$/, 'Invalid dataset release');
    await cp(path.join(bundle, 'dataset'), path.join(delivery, proof.build.release), { recursive: true });
  } else {
    if (phase === '--prepare') {
      await mkdir(path.dirname(bundle), { recursive: true });
      // Refuse stale bundles instead of mixing results from separate builds.
      await mkdir(bundle);
    }
    proof = await prepare();
  }
  report.build = proof.build;
  report.workDir = proof.workDir;
  report.nativeDevice = proof.nativeDevice;
  if (phase === '--prepare') {
    await cp(path.join(delivery, proof.build.release), path.join(bundle, 'dataset'), { recursive: true });
    // Write the receipt last, once all generated data has been copied.
    await writeFile(path.join(bundle, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(`PASS OSM preparation: ${proof.reference.cases.length} fresh native results → ${relative(bundle)}`);
  } else {
    await verify(proof);
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stderr: error.stderr ?? null };
  throw error;
} finally {
  // Only the temporary delivery directory created by this test is removed.
  // Native graph/config/build reports remain under the printed workDir for inspection.
  await rm(delivery, { recursive: true, force: true });
  await writeReport(phase === '--prepare' ? 'dataset-build-prepare' : 'dataset-build', report);
}
