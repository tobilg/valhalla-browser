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
  const sdk = JSON.parse(await readFile(path.join(root, 'packages/valhalla-browser/package.json')));
  if (sdk.name !== 'valhalla-browser') throw new Error('Unexpected SDK package name.');
  if (command === 'validate') {
    validateTag(argument, sdk.version);
    await output({ version: sdk.version, tarball: `${sdk.name}-${sdk.version}.tgz` });
  } else if (command === 'candidate') {
    validateTag(`v${sdk.version}`, sdk.version);
    const filename = `${sdk.name}-${sdk.version}.tgz`;
    const bytes = await readFile(path.join(root, 'build/package', filename));
    const candidate = { name: sdk.name, version: sdk.version, filename, integrity: integrity(bytes) };
    await writeFile(path.join(root, 'build/package/release.json'), JSON.stringify(candidate, null, 2) + '\n');
    await output({ version: sdk.version, tarball: filename });
  } else if (command === 'published') {
    const candidate = JSON.parse(await readFile(path.join(root, 'build/package/release.json')));
    if (candidate.name !== sdk.name || candidate.version !== sdk.version || candidate.filename !== `${sdk.name}-${sdk.version}.tgz`)
      throw new Error('Release manifest does not match this source version.');
    if (candidate.integrity !== integrity(await readFile(path.join(root, 'build/package', candidate.filename)))) throw new Error('Release tarball integrity mismatch.');
    await output({ published: await publishedState(candidate) });
  } else throw new Error('Usage: node scripts/release.js validate vX.Y.Z | candidate | published');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
