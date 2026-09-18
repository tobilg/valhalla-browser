// A fresh ephemeral browser origin can miss a stale CDN variant belonging to
// the real app origin. Check those exact cache variants before benchmarking.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readBounded, readMetadata, sha256, TileLoader } from '../packages/valhalla-browser/src/loader.ts';

export const demoOrigins = () => (process.env.CORS_ORIGINS ??
  'http://127.0.0.1:8080,http://127.0.0.1:8087,http://localhost:8080,http://localhost:8087').split(',');

export async function checkCDNCors(manifestUrl, origins = demoOrigins()) {
  const report = { at: new Date().toISOString(), manifestUrl, checks: [],
    scope: 'Real HTTP requests with exact Origin headers; browser response-header contract check, not browser routing.' };
  for (const origin of origins) {
    assert.equal(new URL(origin).origin, origin, 'CORS_ORIGINS entries must be origins without a path.');
    const check = { origin, responses: [] };
    report.checks.push(check);
    async function get(url, range) {
      const response = await fetch(url, { credentials: 'omit', headers: { Origin: origin, ...(range ? { Range: range } : {}) }, signal: AbortSignal.timeout(15000) });
      const headers = Object.fromEntries(['access-control-allow-origin', 'access-control-expose-headers', 'content-range',
        'content-length', 'content-encoding', 'etag', 'cf-cache-status', 'cf-ray', 'age', 'vary'].map(name => [name, response.headers.get(name)]));
      check.responses.push({ url, range: range ?? null, status: response.status, headers });
      try {
        assert.equal(response.status, range ? 206 : 200, 'Unexpected HTTP status');
        assert(['*', origin].includes(headers['access-control-allow-origin']), `Missing/mismatched Access-Control-Allow-Origin for ${origin}`);
        if (range) {
          const exposed = (headers['access-control-expose-headers'] ?? '').toLowerCase().split(/\s*,\s*/);
          for (const name of ['etag', 'content-range', 'content-encoding'])
            assert(exposed.includes(name) || exposed.includes('*'), `Missing exposed ${name} for ${origin}`);
        }
        return response;
      } catch (error) { await response.body?.cancel(); throw error; }
    }
    try {
      const manifest = JSON.parse(new TextDecoder().decode(await readMetadata(await get(manifestUrl))));
      const loader = new TileLoader(manifest, manifestUrl);
      const response = await get(loader.archiveUrl, 'bytes=0-511');
      try {
        assert.equal(response.headers.get('Content-Range'), `bytes 0-511/${manifest.archive.size}`);
        assert.equal(response.headers.get('ETag'), manifest.archive.etag);
        assert.equal(await sha256(await readBounded(response, 512)), manifest.archive.headerSha256);
      } finally { if (!response.bodyUsed) await response.body?.cancel(); }
      check.passed = true;
    } catch (error) { check.passed = false; check.error = error.message; }
  }
  report.passed = report.checks.every(check => check.passed);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestUrl = process.env.MANIFEST_URL ?? process.argv[2];
  if (!manifestUrl || new URL(manifestUrl).protocol !== 'https:')
    throw new Error('Usage: pnpm run test:cdn:cors https://host/release/manifest.json');
  const report = await checkCDNCors(manifestUrl);
  for (const check of report.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.origin}${check.error ? ': ' + check.error : ''}`);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/cdn-cors.json', JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
