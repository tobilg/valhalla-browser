import { readFile, writeFile } from 'node:fs/promises';
import { validateTag } from './release.js';

const packages = [
  ['valhalla-browser', 'valhalla-browser'],
  ['valhalla-server', 'valhalla-server'],
  ['valhalla-core', '@tobilg/valhalla-core'],
  ['demo', '@tobilg/valhalla-browser-demo'],
  ['documentation', '@tobilg/valhalla-browser-documentation'],
];
const documentation = ['README.md', 'docs/development.md'];

function updateExamples(contents, version) {
  // Match SDK references only: toolchain versions and historical reports stay intact.
  return contents
    .replace(/(\bvalhalla-(?:browser|server)[@-])\d+\.\d+\.\d+\b/g, (_, prefix) => `${prefix}${version}`)
    .replace(/(\/sdk\/)\d+\.\d+\.\d+(?=\/)/g, (_, prefix) => `${prefix}${version}`)
    .replace(/(The repository prepares version \*\*)\d+\.\d+\.\d+(?=\*\*)/g, (_, prefix) => `${prefix}${version}`)
    .replace(/(After publishing version )\d+\.\d+\.\d+(?=,)/g, (_, prefix) => `${prefix}${version}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const [version] = args;
  if (args.length !== 1 || version !== version.trim())
    throw new Error('Usage: pnpm run version:set X.Y.Z (or npm run version:set -- X.Y.Z).');
  validateTag(`v${version}`, version);

  // Read all inputs and validate every manifest before modifying any file.
  // Resolve against this script so invocation does not depend on the shell's cwd.
  const updates = await Promise.all(packages.map(async ([directory, name]) => {
    const file = new URL(`../packages/${directory}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    if (pkg.name !== name) throw new Error(`Unexpected package name in ${file.pathname}: ${pkg.name}`);
    pkg.version = version;
    return { file, pkg };
  }));
  const docs = await Promise.all(documentation.map(async relative => {
    const file = new URL(`../${relative}`, import.meta.url);
    return { file, contents: updateExamples(await readFile(file, 'utf8'), version) };
  }));
  for (const { file, pkg } of updates) await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  for (const { file, contents } of docs) await writeFile(file, contents);
  console.log(`Set all five packages to ${version}: ${updates.map(({ pkg }) => pkg.name).join(', ')}`);
  console.log(`Updated SDK version references in ${documentation.join(' and ')}.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
