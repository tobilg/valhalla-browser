// Read public deployment headers and write a separate delivery manifest locally.
// No bucket credentials, upload, or whole-archive download is needed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, 'base-url': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: pnpm run data:etags --manifest public/datasets/RELEASE/manifest.json --base-url https://routing.example.com/datasets/RELEASE/ --output build/hosting/manifest.json');
  process.exit(0);
}
if (!values.manifest || !values['base-url'] || !values.output) throw new Error('Require --manifest, --base-url and --output. Use --help.');
if (path.resolve(values.manifest) === path.resolve(values.output)) throw new Error('Use a separate output; preserve the manifest for local SHA-256 ETag hosting.');
const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
const base = new URL(values['base-url']);
if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    base.pathname.split('/').at(-2) !== manifest.release || !base.pathname.endsWith('/'))
  throw new Error('Base URL must end with /<manifest.release>/ and contain no credentials, query or fragment.');
const strong = value => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,256}"$/.test(value);
async function validator(relative, size) {
  const url = new URL(relative, base);
  if (!url.href.startsWith(base.href)) throw new Error('Object URL escapes the release directory.');
  const response = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || response.headers.get('content-length') !== size) throw new Error(`Unexpected HEAD status/length for ${relative}`);
  if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new Error(`Graph must be uncompressed: ${relative}`);
  const etag = response.headers.get('etag');
  if (!strong(etag)) throw new Error(`Missing strong ETag for ${relative}`);
  return etag;
}
manifest.archive.etag = await validator(manifest.archive.url, manifest.archive.size);
for (const tile of Object.values(manifest.tiles)) tile.etag = await validator(`tiles/${tile.path}`, tile.size);
await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
// Exclusive creation prevents accidentally replacing a previously prepared delivery manifest.
await writeFile(values.output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(`Wrote ${values.output}; observed ${Object.keys(manifest.tiles).length + 1} strong validators. Upload this manifest last, under ${manifest.release}/manifest.json.`);
