import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile, readdir, stat, mkdir, cp, symlink, mkdtemp } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { root, execute, listen, closeHost, writeReport, sha256 } from './package-support.js';

// Build a copy containing documentation and SDK source only: no WASM, graphs or native tree.
await mkdir(path.join(root, 'build'), { recursive: true });
const isolated = await mkdtemp(path.join(root, 'build/docs-source-only-'));
await mkdir(path.join(isolated, 'packages'), { recursive: true });
await cp(path.join(root, 'README.md'), path.join(isolated, 'README.md'));
await mkdir(path.join(isolated, 'assets'));
await cp(path.join(root, 'assets/og-image.jpg'), path.join(isolated, 'assets/og-image.jpg'));
await mkdir(path.join(isolated, 'docs'));
for (const guide of ['building-graph-data.md', 'object-storage-hosting.md', 'server-routing.md'])
  await cp(path.join(root, 'docs', guide), path.join(isolated, 'docs', guide));
for (const dir of ['documentation', 'valhalla-browser', 'valhalla-core', 'valhalla-server']) {
  await cp(path.join(root, 'packages', dir), path.join(isolated, 'packages', dir), {
    recursive: true, filter: source => !['node_modules', 'dist', 'build'].includes(path.basename(source)),
  });
}
const sourceOnlyDocs = path.join(isolated, 'packages/documentation');
// Recreate the SDKs' workspace links to the copied core source, keeping this
// check independent of generated declarations and the original source tree.
for (const sdk of ['valhalla-browser', 'valhalla-server']) {
  const scope = path.join(isolated, 'packages', sdk, 'node_modules/@tobilg');
  await mkdir(scope, { recursive: true });
  await symlink(path.join(isolated, 'packages/valhalla-core'), path.join(scope, 'valhalla-core'), 'dir');
}
await symlink(path.join(root, 'packages/documentation/node_modules'), path.join(sourceOnlyDocs, 'node_modules'), 'dir');
await execute(process.execPath, [path.join(root, 'packages/documentation/node_modules/typedoc/bin/typedoc'), '--disableSources'], { cwd: sourceOnlyDocs, maxBuffer: 4 * 1024 * 1024 });
assert((await stat(path.join(sourceOnlyDocs, 'dist/index.html'))).isFile());

const output = path.join(root, 'packages/documentation/dist');
const html = new Map();
async function collect(dir, prefix = '') {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) await collect(path.join(dir, item.name), `${relative}/`);
    else {
      assert(!relative.endsWith('.wasm') && !relative.endsWith('.gph') && !relative.endsWith('.tar'));
      if (relative.endsWith('.html')) html.set('/' + relative, await readFile(path.join(dir, item.name), 'utf8'));
    }
  }
}
await collect(output);
const host = { server: http.createServer(async (req, res) => {
  try {
    let relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(output, '.' + relative);
    assert(file.startsWith(output + path.sep));
    const bytes = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' }[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
}) };
const base = await listen(host);
const report = { at: new Date().toISOString(), sourceOnlyBuild: true, readmeSha256: sha256(await readFile('README.md')), pages: html.size, browsers: [], passed: false };
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage();
      await page.goto(base);
      await page.locator('h1#valhalla-wasm').waitFor();
      for (const name of ['Install and calculate a route', 'Use directly from a CDN', 'Cancel and route again', 'Reuse a session and inspect diagnostics'])
        await page.getByRole('heading', { name: new RegExp('^' + name) }).waitFor();
      assert(await page.locator('pre').count() >= 8);
      const readmeContent = await page.locator('.col-content .tsd-typography').innerText();
      if (engine === 'chromium') {
        const links = await page.evaluate(entries => entries.flatMap(([pathname, markup]) => {
          const doc = new DOMParser().parseFromString(markup, 'text/html');
          return [...doc.querySelectorAll('a[href], script[src], link[href], img[src]')].map(el => ({ pathname, target: el.getAttribute('href') ?? el.getAttribute('src') }));
        }), [...html]);
        const seen = new Set();
        for (const { pathname, target } of links) {
          const url = new URL(target, base + pathname);
          if (url.origin !== base || seen.has(url.href)) continue;
          seen.add(url.href);
          let file = decodeURIComponent(url.pathname); if (file.endsWith('/')) file += 'index.html';
          assert((await stat(path.join(output, file))).isFile(), url.href);
          if (url.hash && html.has(file)) {
            const id = decodeURIComponent(url.hash.slice(1));
            const exists = await page.evaluate(({ markup, id }) => !!new DOMParser().parseFromString(markup, 'text/html').getElementById(id), { markup: html.get(file), id });
            assert(exists, `Broken anchor ${url.href}`);
          }
        }
        report.internalLinks = seen.size;
      }
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('combobox').fill('Router');
      const result = page.locator('#tsd-search-results a[href*="/Router/"]').first();
      await result.waitFor(); await result.click();
      await page.getByRole('heading', { name: 'Class Router', exact: false }).waitFor();
      assert.match(await page.locator('body').innerText(), /initialize/);
      for (const title of ['Cancellation and errors', 'CDN and CSP', 'Datasets and transports',
        'Diagnostics and memory', 'Travel profiles and options', 'Build graph data from OpenStreetMap', 'Host graph data on object storage']) {
        const link = page.locator('#tsd-nav-container').getByRole('link').filter({ hasText: new RegExp('^' + title + '$') });
        await link.click();
        await page.getByRole('heading', { name: new RegExp('^' + title) }).waitFor();
        if (title === 'Build graph data from OpenStreetMap')
          assert.match(await page.locator('body').innerText(), /pnpm run data:osm/);
      }
      for (const topic of ['Cloudflare R2: dashboard setup', 'Amazon S3, with or without CloudFront', 'Verify the final public URL'])
        await page.getByRole('heading', { name: new RegExp(topic) }).waitFor();
      // The sidebar project link opens a separate overview; it must show the
      // complete README too, and the header must return to the local homepage.
      await page.locator('.site-menu').getByRole('link', { name: 'valhalla-wasm API', exact: true }).click();
      await page.locator('.col-content .tsd-typography h1').waitFor();
      assert.equal(await page.locator('.col-content .tsd-typography').innerText(), readmeContent);
      await page.getByRole('heading', { name: /^Modules\b/ }).waitFor();
      assert.equal(await page.locator('a.title').getAttribute('href'), '/');
      await page.locator('a.title').click();
      assert.equal(new URL(page.url()).pathname, '/');
      await page.locator('h1#valhalla-wasm').waitFor();
      assert.equal(await page.locator('.col-content .tsd-typography').innerText(), readmeContent);
      report.browsers.push({ engine, version: browser.version(), passed: true });
      console.log(`PASS documentation: ${engine} homepage, search, API and guides`);
    } finally { await browser.close(); }
  }
  report.passed = true;
} finally { await closeHost(host); await writeReport('docs', report); }
