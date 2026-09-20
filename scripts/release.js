import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validateTag(tag, version) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error('Release tag must be stable vMAJOR.MINOR.PATCH.');
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match SDK version ${version}.`);
  return version;
}
export const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export function verifyPublished(metadata, expected) {
  if (metadata.name !== expected.name || metadata.version !== expected.version || metadata.dist?.integrity !== expected.integrity)
    throw new Error('Published package does not match the verified release artifact; refusing to continue.');
}
export async function publishedState(expected, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(expected.name)}/${encodeURIComponent(expected.version)}`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Cannot verify npm publication: HTTP ${response.status}.`);
  verifyPublished(await response.json(), expected);
  return true;
}
async function output(values) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  console.log(JSON.stringify(values));
}
async function main() {
  const [command, argument] = process.argv.slice(2);
  const names = ['valhalla-browser', 'valhalla-server'];
  const packages = await Promise.all(names.map(async name => {
    const pkg = JSON.parse(await readFile(path.join(root, 'packages', name, 'package.json')));
    if (pkg.name !== name) throw new Error('Unexpected SDK package name.');
    return pkg;
  }));
  const version = packages[0].version;
  for (const directory of ['valhalla-core', 'demo', 'documentation'])
    packages.push(JSON.parse(await readFile(path.join(root, 'packages', directory, 'package.json'))));
  if (packages.some(pkg => pkg.version !== version)) throw new Error('All five workspace packages must have the same version.');
  const filenames = Object.fromEntries(names.map(name => [name, `${name}-${version}.tgz`]));
  if (command === 'validate') {
    validateTag(argument, version);
    await output({ version, tarball: filenames['valhalla-browser'], server_tarball: filenames['valhalla-server'] });
  } else if (command === 'candidate') {
    validateTag(`v${version}`, version);
    const candidates = await Promise.all(names.map(async name => {
      const filename = filenames[name];
      const bytes = await readFile(path.join(root, 'build/package', filename));
      return { name, version, filename, integrity: integrity(bytes) };
    }));
    await writeFile(path.join(root, 'build/package/release.json'), JSON.stringify({ version, packages: candidates }, null, 2) + '\n');
    await output({ version, tarball: filenames['valhalla-browser'], server_tarball: filenames['valhalla-server'] });
  } else if (command === 'published') {
    if (!names.includes(argument)) throw new Error('Specify valhalla-browser or valhalla-server.');
    const manifest = JSON.parse(await readFile(path.join(root, 'build/package/release.json')));
    if (manifest.version !== version || manifest.packages?.length !== names.length ||
        manifest.packages.some((entry, index) => entry.name !== names[index]))
      throw new Error('Release manifest does not match the source packages.');
    for (const candidate of manifest.packages) {
      if (candidate.version !== version || candidate.filename !== filenames[candidate.name] ||
          candidate.integrity !== integrity(await readFile(path.join(root, 'build/package', candidate.filename))))
        throw new Error('Release tarball identity or integrity mismatch.');
    }
    await output({ published: await publishedState(manifest.packages.find(candidate => candidate.name === argument)) });
  } else throw new Error('Usage: node scripts/release.js validate vX.Y.Z | candidate | published PACKAGE');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
