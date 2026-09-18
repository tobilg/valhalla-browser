// Read-only transport diagnostics, including when a remote delivery manifest is
// misconfigured. This deliberately uses the verified local R2 manifest and does
// not claim to validate browser routing through the public manifest.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import { TileLoader, readMetadata, sha256 } from '../packages/valhalla-browser/src/loader.ts';

const manifestUrl = process.env.MANIFEST_URL ?? process.argv[2];
if (!manifestUrl || new URL(manifestUrl).protocol !== 'https:')
  throw new Error('Usage: pnpm run test:cdn:objects https://host/release/manifest.json');
const canonical = JSON.parse(await readFile('fixtures/region/manifest.json'));
const manifest = JSON.parse(await readFile(`build/r2-upload/datasets/${canonical.release}/manifest.json`));
const report = { at: new Date().toISOString(), manifestUrl, release: manifest.release,
  device: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model },
  scope: 'Node network/integrity checks using the verified local R2 delivery manifest; not browser routing or browser HTTP-cache measurements.',
  originBytes: null, objects: [], rangeSamples: [] };
const loader = new TileLoader(manifest, manifestUrl);
try {
  const config = await readMetadata(await fetch(new URL(manifest.config.url, manifestUrl), { signal: AbortSignal.timeout(15000) }));
  assert.equal(await sha256(config), manifest.config.sha256);
  report.configBytes = config.length;
  await loader.get(loader.archiveUrl, 0n, 512n);
  await loader.get(loader.archiveUrl, 512n, loader.indexSize);
  for (const tile of loader.byRange.values()) {
    const archive = await loader.get(loader.archiveUrl, tile.offset, tile.size);
    const individual = await loader.get(tile.url);
    assert.deepEqual(archive, individual);
    report.objects.push({ id: tile.id, path: tile.path, size: String(tile.size), sha256: await sha256(archive), equal: true });
  }
  for (let i = 0; i < 20; i++) {
    await loader.get(loader.archiveUrl, 0n, 512n);
    report.rangeSamples.push(loader.trace.at(-1));
  }
  const times = report.rangeSamples.map(r => r.elapsedMs).sort((a, b) => a - b);
  report.rangeMs = { n: times.length, p50: times[9], p95: times[18] };
  report.passed = true;
  console.log(JSON.stringify({ passed: true, tiles: report.objects.length, rangeMs: report.rangeMs }, null, 2));
} catch (error) {
  report.passed = false; report.failure = error.message; process.exitCode = 1; console.error(error);
} finally {
  report.graphMetrics = loader.metrics; report.trace = loader.trace;
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/cdn-objects.json', JSON.stringify(report, null, 2) + '\n');
}
