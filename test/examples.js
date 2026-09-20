import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createRangeServer } from '../scripts/server.js';
import { packedFixture, execute, readJSON, listen, closeHost, staticHost, writeReport } from './package-support.js';

const fixture = await packedFixture();
const examples = [...(await readFile('README.md', 'utf8')).matchAll(/<!-- example:([\w-]+) -->\s*```(ts|html)\n([\s\S]*?)\n```/g)].map(([, name, language, code]) => ({ name, language, code }));
assert.equal(examples.length, 7, 'All README examples must be discovered');
const consumer = path.join(fixture.directory, 'readme-consumer'); await mkdir(consumer);
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'readme-consumer', private: true, type: 'module', packageManager: 'pnpm@12.4.2', dependencies: { 'valhalla-browser': `file:${fixture.tarball}` }, devDependencies: Object.fromEntries(Object.entries(fixture.pkg.devDependencies).filter(([name]) => name !== '@tobilg/valhalla-core')) }));
// Fresh consumers need registry metadata even if the workspace's packages are cached.
await execute('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: consumer, maxBuffer: 4 * 1024 * 1024 });
const graph = createRangeServer({ faults: true }); const graphOrigin = await listen(graph);
const manifest = await readJSON('fixtures/region/manifest.json');
const reference = await readJSON('fixtures/region/reference.json');
const expected = reference.cases.find(c => c.name === 'balzers-ruggell').expected;
const manifestUrl = `${graphOrigin}/datasets/${manifest.release}/manifest.json`;
// Execute the documented deployment placeholders against our local graph fixture.
const sampleManifestUrl = 'https://routing.example.com/datasets/your-release-id/manifest.json';
const replaceData = code => code.replaceAll(sampleManifestUrl, manifestUrl);
for (const { name, language, code } of examples) if (language === 'ts') await writeFile(path.join(consumer, `${name}.ts`), replaceData(code));
await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES2022', 'DOM'], types: [] }, include: ['*.ts'] }));
await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: consumer });
await writeFile(path.join(consumer, 'index.html'), '<!doctype html><title>README examples</title>');
const { createServer } = await import(pathToFileURL(path.join(consumer, 'node_modules/vite/dist/node/index.js')));
const vite = await createServer({ root: consumer, configFile: false, publicDir: false, logLevel: 'warn', server: { host: 'localhost', port: 0, fs: { allow: [consumer] } } }); await vite.listen();
const cdn = staticHost({ packageRoot: fixture.packageRoot }); const cdnOrigin = await listen(cdn);
const cdnExample = examples.find(e => e.name === 'cdn');
const cdnImport = `https://cdn.jsdelivr.net/npm/valhalla-browser@${fixture.pkg.version}/dist/index.js`;
assert(cdnExample.code.includes(cdnImport), 'The README CDN example must use the candidate SDK version');
const app = staticHost({ html: replaceData(cdnExample.code).replace(cdnImport, `${cdnOrigin}/sdk/0.0.1/dist/index.js`) });
const appOrigin = await listen(app);
const browser = await chromium.launch();
const report = { at: new Date().toISOString(), browser: browser.version(), typecheckedExamples: examples.filter(e => e.language === 'ts').map(e => e.name), tests: [], passed: false };
try {
  for (const { name, language } of examples) {
    const page = await browser.newPage();
    try {
      if (language === 'ts') {
        await page.goto(vite.resolvedUrls.local[0]);
        const logs = await page.evaluate(async name => {
          const logs = []; const original = console.log;
          console.log = (...args) => logs.push(args);
          try { await import(`/${name}.ts`); return logs; }
          finally { console.log = original; }
        }, name);
        if (name === 'quick-start') assert.deepEqual(logs[0][0], expected);
        if (name === 'typescript' || name === 'cancellation') assert.deepEqual(logs[0][0], expected.trip.summary);
        if (name === 'cache') { assert.equal(logs[0][0], 0); assert(logs[1][0] > 0); }
        if (name === 'errors') assert(logs.some(args => args[0] === 'routing'));
        if (name === 'profiles') for (const [i, costing] of ['bicycle','pedestrian','truck'].entries())
          assert.deepEqual(logs[i][0], reference.cases.find(c => c.name === `vaduz-short-${costing}-configured`).expected);
      } else {
        await page.goto(appOrigin); await page.getByRole('button', { name: 'Calculate route' }).click();
        await page.waitForFunction(() => document.querySelector('#result').textContent.startsWith('{'));
        assert.deepEqual(JSON.parse(await page.locator('#result').textContent()), expected);
      }
      report.tests.push({ name, passed: true }); console.log(`PASS README example: ${name}`);
    } finally { await page.close(); }
  }
  const archives = graph.records.filter(r => r.path.endsWith('/graph.tar'));
  assert(archives.length > 0 && archives.every(r => r.status === 206 && r.range && r.bodyBytes < Number(manifest.archive.size)));
  report.passed = true;
} finally {
  await browser.close(); await vite.close(); await closeHost(graph); await closeHost(cdn); await closeHost(app); await writeReport('examples', report);
}
