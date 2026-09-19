import { build } from 'vite';
import { readFile, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fromRepo = relative => path.join(repoRoot, relative);
process.chdir(packageRoot);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const versions = await json(fromRepo('versions.json'));
const runtimeLock = await json(fromRepo('native/runtime-lock.json'));
const pkg = await json('package.json');
for (const [key, expected] of Object.entries(runtimeLock.versions)) {
  if (versions[key] !== expected) throw new Error(`Runtime provenance changed (${key}); rebuild and verify the native artifact record first.`);
}
for (const [path, expected] of Object.entries(runtimeLock.artifacts)) {
  let bytes;
  try { bytes = await readFile(fromRepo(path)); }
  catch { throw new Error(`Missing ${path}. Run pnpm run build:wasm before packaging. Package installation never builds WASM.`); }
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
    throw new Error(`${path} does not match the verified runtime. Rebuild with the pinned toolchain and verify native/runtime-lock.json.`);
}
for (const name of ['Valhalla.txt', 'Protobuf.txt', 'zlib.txt', 'Boost.txt', 'date.txt', 'RapidJSON.txt',
  'unordered_dense.txt', 'cpp-statsd-client.txt', 'cxxopts.txt', 'protozero.txt', 'vtzero.txt', 'IANA-tz.txt', 'Emscripten.txt', 'musl.txt', 'NOTICE.md']) {
  await readFile(fromRepo(`public/wasm/licenses/${name}`)).catch(() => { throw new Error(`Missing runtime license ${name}; run pnpm run build:wasm.`); });
}

// Non-library build: Emscripten's fallback new URL must emit, never inline, WASM.
await build({
  configFile: false, publicDir: false, base: './',
  build: {
    target: 'es2022', outDir: 'build/package-runtime', emptyOutDir: true,
    assetsInlineLimit: 0, sourcemap: true, modulePreload: false,
    rolldownOptions: {
      input: 'src/worker.ts',
      output: { format: 'es', entryFileNames: 'worker.js', assetFileNames: '[name][extname]' },
    },
  },
});
await build({ configFile: 'vite.config.ts' });
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.client.json'], { stdio: 'inherit' });
await cp(fromRepo('public/wasm/licenses'), 'dist/licenses', { recursive: true });
await cp(fromRepo('NOTICE.md'), 'dist/licenses/NOTICE.md');
await cp(fromRepo('LICENSE'), 'dist/licenses/SDK.txt');
await writeFile('dist/runtime.json', JSON.stringify({ sdk: `${pkg.name}@${pkg.version}`, abi: 1, versions: runtimeLock.versions, artifacts: runtimeLock.artifacts }, null, 2) + '\n');
for (const name of ['README.md', 'LICENSE', 'NOTICE.md']) await cp(fromRepo(name), name);
console.log(`Packaged ${pkg.name}@${pkg.version}; WASM ${runtimeLock.artifacts['public/wasm/valhalla-browser.wasm'].sha256}`);
