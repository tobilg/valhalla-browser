import { build } from 'vite';
import { readFile, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageDeclarations } from '../../../scripts/package-declarations.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = new URL('../../../', import.meta.url);
process.chdir(root);
const lock = JSON.parse(await readFile(new URL('native/runtime-lock.json', repo), 'utf8'));
const versions = JSON.parse(await readFile(new URL('versions.json', repo), 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
for (const [key, expected] of Object.entries(lock.versions)) {
  if (versions[key] !== expected) throw new Error(`Rebuild runtime provenance: ${key} changed.`);
}
for (const extension of ['js', 'wasm']) {
  const path = `public/wasm/valhalla.${extension}`;
  const bytes = await readFile(new URL(path, repo));
  const expected = lock.artifacts[path];
  if (!expected || bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
    throw new Error(`${path} differs from the pinned build. Rebuild and verify native/runtime-lock.json.`);
}
await build({
  configFile: false, publicDir: false,
  ssr: { noExternal: ['@tobilg/valhalla-core'] },
  build: {
    ssr: true, target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: true, minify: false,
    rolldownOptions: {
      input: { index: 'src/index.ts', node: 'src/node.ts', 'node-worker': 'src/node-worker.ts', cloudflare: 'src/cloudflare.ts' },
      external: id => id.startsWith('node:') || /valhalla\.(js|wasm)$/.test(id),
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js',
        paths: id => /valhalla\.(js|wasm)$/.test(id) ? `./runtime/${id.split('/').at(-1)}` : id },
    },
  },
});
await rm('build/declarations', { recursive: true, force: true });
for (const host of ['node', 'cloudflare']) execFileSync('pnpm', ['exec', 'tsc', '-p', `tsconfig.${host}.json`], { stdio: 'inherit' });
await packageDeclarations(root, 'valhalla-server');
for (const name of ['Valhalla.txt', 'Protobuf.txt', 'zlib.txt', 'Boost.txt', 'date.txt', 'RapidJSON.txt',
  'unordered_dense.txt', 'cpp-statsd-client.txt', 'cxxopts.txt', 'protozero.txt', 'vtzero.txt', 'IANA-tz.txt', 'Emscripten.txt', 'musl.txt', 'NOTICE.md'])
  await readFile(new URL(`public/wasm/licenses/${name}`, repo));
await mkdir('dist/runtime', { recursive: true });
for (const extension of ['js', 'wasm'])
  await cp(new URL(`public/wasm/valhalla.${extension}`, repo), `dist/runtime/valhalla.${extension}`);
await cp(new URL('public/wasm/licenses', repo), 'dist/licenses', { recursive: true });
await cp(new URL('LICENSE', repo), 'dist/licenses/SDK.txt');
for (const file of ['LICENSE', 'NOTICE.md']) await cp(new URL(file, repo), file);
await writeFile('dist/runtime.json', JSON.stringify({ sdk: `${pkg.name}@${pkg.version}`, abi: lock.abi, versions: lock.versions,
  artifacts: lock.artifacts, memory: lock.memory }, null, 2) + '\n');
console.log(`Packaged ${pkg.name}@${pkg.version} with Node and experimental Cloudflare WASM.`);
