import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function cloudflareHarness(server, data) {
  const require = createRequire(await realpath('packages/valhalla-server/node_modules/wrangler/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const versions = { workerd: require('workerd/package.json').version, miniflare: require('miniflare/package.json').version,
    compatibilityDate: '2026-09-20' };
  const bundle = await require('esbuild').build({ entryPoints: ['test/server-cloudflare-worker.js'], bundle: true, format: 'esm', target: 'es2022', write: false, logLevel: 'error',
    plugins: [{ name: 'static-wasm', setup(build) { build.onResolve({ filter: /\.wasm$/ }, () => ({ path: './runtime.wasm', external: true })); } }] });
  const mf = new Miniflare(convertV4MiniflareOptions({ host: 'localhost', port: 0, telemetry: { enabled: false }, workers: [{
    name: 'valhalla-server-proof', compatibilityDate: versions.compatibilityDate, r2Buckets: ['GRAPH_DATA'],
    modules: [{ type: 'ESModule', path: path.resolve('build/server-proof/index.mjs'), contents: bundle.outputFiles[0].text },
      { type: 'CompiledWasm', path: path.resolve('build/server-proof/runtime.wasm'), contents: await readFile('public/wasm/valhalla.wasm') }],
  }] }));
  async function call(input) {
    const response = await mf.dispatchFetch('https://example.com/', { method: 'POST', body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    const output = await response.json();
    if (output.error) throw Object.assign(new Error(output.error.message), output.error);
    return output.result;
  }
  const reset = (corpus, source = 'http', options = {}) => call({ command: 'reset', options: { retries: 0, queueTimeoutMs: 10000, ...options,
    source: source === 'http' ? { type: 'http', manifestUrl: `${server.base}/datasets/${corpus.manifest.release}/manifest.json` }
      : { type: 'r2', manifestKey: `datasets/${corpus.manifest.release}/manifest.json` } } });
  const route = request => call({ command: 'route', request });
  const bucket = await mf.getR2Bucket('GRAPH_DATA');
  // Real Miniflare R2 metadata supplies opaque validators; graph/index bytes and
  // the native reference identity are unchanged. No synthetic TAR index.
  for (const corpus of data) {
    const prefix = `datasets/${corpus.manifest.release}/`;
    const manifest = structuredClone(corpus.manifest);
    for (const file of ['config.json', 'graph.tar', ...Object.values(manifest.tiles).map(tile => `tiles/${tile.path}`)]) {
      const object = await bucket.put(prefix + file, await readFile(`public/${prefix}${file}`));
      if (file === 'graph.tar') manifest.archive.etag = object.httpEtag;
      else if (file.startsWith('tiles/')) Object.values(manifest.tiles).find(tile => `tiles/${tile.path}` === file).etag = object.httpEtag;
    }
    await bucket.put(prefix + 'manifest.json', JSON.stringify(manifest));
  }
  return { mf, bucket, call, reset, route, versions };
}
