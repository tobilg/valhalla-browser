import { readFile, writeFile } from 'node:fs/promises';
import { validateTag } from './release.js';

const packages = [
  ['valhalla-browser', 'valhalla-browser'],
  ['demo', '@tobilg/valhalla-browser-demo'],
  ['documentation', '@tobilg/valhalla-browser-documentation'],
];

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const [version] = args;
  if (args.length !== 1 || version !== version.trim())
    throw new Error('Usage: pnpm run version:set X.Y.Z (or npm run version:set -- X.Y.Z).');
  validateTag(`v${version}`, version);

  // Read and validate every manifest before modifying any package.
  // Resolve against this script so invocation does not depend on the shell's cwd.
  const updates = await Promise.all(packages.map(async ([directory, name]) => {
    const file = new URL(`../packages/${directory}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    if (pkg.name !== name) throw new Error(`Unexpected package name in ${file.pathname}: ${pkg.name}`);
    pkg.version = version;
    return { file, pkg };
  }));
  for (const { file, pkg } of updates) await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Set all three packages to ${version}: ${updates.map(({ pkg }) => pkg.name).join(', ')}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
