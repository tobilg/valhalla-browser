import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { corpora, host, longRoute, report, json } from './server-support.js';

const execute = promisify(execFile);
const pkg = await json('packages/valhalla-server/package.json');
const tarball = path.resolve(process.env.SERVER_TARBALL ?? `build/package/${pkg.name}-${pkg.version}.tgz`);
await readFile(tarball); // Never silently rebuild a CI release candidate.
const directory = await mkdtemp(path.join(os.tmpdir(), 'valhalla-server-consumer-'));
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'isolated-server-consumer', private: true, type: 'module', packageManager: 'pnpm@12.4.2',
  dependencies: { 'valhalla-server': `file:${tarball}` }, devDependencies: Object.fromEntries(['typescript', '@types/node', '@cloudflare/workers-types', 'wrangler'].map(name => [name, pkg.devDependencies[name]])) }));
await execute('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
const packageRoot = path.join(directory, 'node_modules/valhalla-server');
assert(!(await json(path.join(packageRoot, 'package.json'))).dependencies, 'No private workspace runtime dependency.');
const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(file);
    else {
      files.push(path.relative(packageRoot, file));
      if (file.endsWith('.js') || file.endsWith('.d.ts')) {
        assert.doesNotMatch(await readFile(file, 'utf8'),
          /['"](?:@tobilg\/valhalla-core(?:['"/])|(?:\.\.\/)+valhalla-core\/src\/)/,
          `Private workspace import in published file: ${file}`);
      }
    }
  }
}
await collect(packageRoot);
assert.equal(files.filter(name => name.endsWith('.wasm')).length, 1);
assert(files.includes('dist/runtime/valhalla.wasm'));
const testTypes = `import { Router, createRouter, RoutingError } from 'valhalla-server/node';
import type { RouteRequest, RouteResult, SearchMemoryOptions } from 'valhalla-server';
const request: RouteRequest = { origin: {lat:47,lon:9}, destination: {lat:47.1,lon:9.1}, costing:'bicycle' };
const search: SearchMemoryOptions = {astar:0,bidirectionalAstar:16384};
const router = new Router({manifestUrl:'https://example.com/release/manifest.json',searchMemory:search,wasmMemory:{initialMiB:64,maximumMiB:256}});
// @ts-expect-error Memory limits use numeric MiB.
new Router({manifestUrl:'https://example.com',wasmMemory:{maximumMiB:'96'}});
const result: Promise<RouteResult> = router.route(request,{signal:new AbortController().signal});
// @ts-expect-error Browser worker factories are not server options.
new Router({manifestUrl:'https://example.com',workerFactory:()=>null});
// @ts-expect-error Unsupported transit profile.
router.route({...request,costing:'transit'});
void result; void createRouter; void RoutingError;`;
await writeFile(path.join(directory, 'node-consumer.ts'), testTypes);
await writeFile(path.join(directory, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'], types: ['node'] }, files: ['node-consumer.ts'] }));
await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.node.json'], { cwd: directory });
await cp('examples/cloudflare/index.ts', path.join(directory, 'index.ts'));
const config = (await readFile('examples/cloudflare/wrangler.jsonc', 'utf8')).replace('../../node_modules/wrangler', './node_modules/wrangler');
await writeFile(path.join(directory, 'wrangler.jsonc'), config);
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
await execute('pnpm', ['exec', 'wrangler', 'types', 'worker-configuration.d.ts'], { cwd: directory, env: environment, maxBuffer: 4 * 1024 * 1024 });
await writeFile(path.join(directory, 'tsconfig.cloudflare.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022'], types: [] }, files: ['index.ts', 'worker-configuration.d.ts'] }));
await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.cloudflare.json'], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
const dryRun = await execute('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', 'bundle'], { cwd: directory, env: environment, maxBuffer: 4 * 1024 * 1024 });
assert((await readdir(path.join(directory, 'bundle'))).some(name => name.endsWith('.wasm')));
const server = await host();
const corpus = (await corpora())[1];
const request = longRoute(corpus);
await writeFile(path.join(directory, 'route.mjs'), `import assert from 'node:assert/strict';
import * as shared from 'valhalla-server';
import {createRouter} from 'valhalla-server/node';
assert.equal(shared.Router,undefined);
const router=await createRouter({manifestUrl:${JSON.stringify(`${server.base}/datasets/${corpus.manifest.release}/manifest.json`)}});
try { assert.deepEqual((await router.route(${JSON.stringify(request.request)})).native,${JSON.stringify(request.expected)}); }
finally { await router.dispose(); }`);
try {
  await execute(process.execPath, ['route.mjs'], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
  await report('server-package', { passed: true, tarball, files, nodeTypesWithoutDOM: true, cloudflareGeneratedTypes: true, wranglerDryRun: dryRun.stdout });
  console.log('PASS installed server package: Node route, strict Node/Workers types, static WASM Wrangler dry-run');
} finally { await server.close(); }
