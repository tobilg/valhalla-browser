// Reproduce intermittent browser worker-load errors after immediate cancellation.
// This test never retries a failed route; startup recovery belongs to the SDK.
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { readJSON, listen, closeHost, writeReport, device } from './package-support.js';

const engineName = process.env.BROWSER ?? 'webkit';
const engine = { chromium, firefox, webkit }[engineName];
const cycles = Number(process.env.RECOVERY_CYCLES ?? 10);
assert(engine, `Unknown BROWSER: ${engineName}`);
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 500, 'RECOVERY_CYCLES must be 1–500');
const reference = await readJSON('fixtures/region/reference.json');
const fixture = reference.cases.find(c => c.name === 'balzers-ruggell');
const minio = process.argv.includes('--minio');
const discovery = minio ? await readJSON('public/minio.json') : null;
const dataset = discovery?.datasets.find(d => d.manifestUrl.includes(`/${reference.release}/`));
assert(!minio || dataset, 'Publish the regional fixture with pnpm run minio:publish first');
const host = createRangeServer();
const base = await listen(host);
const manifestUrl = minio
  ? dataset.manifestUrl
  : `${base}/datasets/${reference.release}/manifest.json`;
const report = { at: new Date().toISOString(), engine: engineName, device: device(), node: process.version,
  delivery: minio ? 'MinIO' : 'local HTTP', cycles, samples: [], passed: false };
let browser;
try {
  browser = await engine.launch();
  report.browser = browser.version();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const context = await browser.newContext();
    const sample = { cycle, requestFailures: [], browserErrors: [], passed: false };
    report.samples.push(sample);
    try {
      const page = await context.newPage();
      page.on('requestfailed', request => sample.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
      page.on('pageerror', error => sample.browserErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') sample.browserErrors.push(message.text()); });
      await page.goto(base);
      await page.evaluate(async manifestUrl => {
        const { Router } = await import('/dist/index.js');
        window.router = new Router({ manifestUrl });
        await window.router.initialize();
      }, manifestUrl);
      const cancelled = await page.evaluate(async request => {
        let requested = false;
        window.router.options.onProgress = event => {
          if (event.phase === 'fetching-tile' && !requested) { requested = true; window.router.cancel(); }
        };
        try { await window.router.route(request); return { resolved: true }; }
        catch (error) { return { code: error.code, requested }; }
        finally { window.router.options.onProgress = undefined; }
      }, fixture.request);
      assert.deepEqual(cancelled, { code: 'CANCELLED', requested: true });
      const result = await page.evaluate(request => window.router.route(request), fixture.request);
      assert.deepEqual(result.native, fixture.expected);
      assert.equal(result.dataset.release, reference.release);
      sample.recovery = result.diagnostics;
      sample.passed = true;
      console.log(`PASS ${engineName} cancellation/recovery ${cycle}/${cycles}`);
    } finally { await context.close(); }
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await browser?.close();
  await closeHost(host);
  await writeReport('worker-recovery', report);
}
