import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile);
const root = new URL('../', import.meta.url);
const manifests = ['packages/valhalla-browser/package.json', 'packages/valhalla-server/package.json', 'packages/valhalla-core/package.json', 'packages/demo/package.json', 'packages/documentation/package.json'];
const documentation = ['README.md', 'docs/development.md'];
const history = 'docs/workspace-verification.md';
const tracked = ['package.json', 'pnpm-lock.yaml', ...manifests, ...documentation, history];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'valhalla-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of [...tracked, 'scripts/set-version.js', 'scripts/release.js']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await cp(new URL(file, root), path.join(directory, file));
  }
  const snapshot = () => Promise.all(tracked.map(file => readFile(path.join(directory, file), 'utf8')));
  const run = args => execute(process.execPath, [path.join(directory, 'scripts/set-version.js'), ...args], { cwd: path.join(directory, 'packages/demo') });
  return { directory, snapshot, run };
}

test('npm argument forwarding updates packages and documentation while preserving unrelated metadata', async t => {
  const { directory, snapshot, run } = await fixture(t);
  const before = await snapshot();
  await execute('npm', ['run', 'version:set', '--', '1.2.3'], { cwd: directory });
  const after = await snapshot();
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  for (let i = 2; i < 2 + manifests.length; i++) assert.deepEqual(JSON.parse(after[i]), { ...JSON.parse(before[i]), version: '1.2.3' });
  const readme = await readFile(path.join(directory, 'README.md'), 'utf8');
  assert(readme.includes('valhalla-browser@1.2.3/dist/index.js'));
  assert(readme.includes('The examples use version **1.2.3**'));
  assert(readme.includes('/sdk/1.2.3/worker.js'));
  assert(readme.includes('/sdk/1.2.3/valhalla-browser.wasm'));
  for (const file of documentation) assert((await readFile(path.join(directory, file), 'utf8')).includes('valhalla-browser-1.2.3.tgz'));
  assert.equal(after.at(-1), before.at(-1), 'Historical verification evidence must keep its original version');
  const developmentIndex = tracked.indexOf('docs/development.md');
  const leafletReference = before[developmentIndex].match(/Leaflet \d+\.\d+\.\d+/)[0];
  assert(after[developmentIndex].includes(leafletReference));
  // Running from a nested directory with pnpm's explicit separator also works.
  await run(['--', '1.2.3']);
  assert.deepEqual(await snapshot(), after);
  await run(['2.0.0']);
  assert((await readFile(path.join(directory, 'README.md'), 'utf8')).includes('valhalla-browser@2.0.0/dist/index.js'));
});

test('invalid version arguments leave every manifest unchanged', async t => {
  const { snapshot, run } = await fixture(t);
  const before = await snapshot();
  for (const args of [[], ['1.2'], ['v1.2.3'], ['01.2.3'], ['1.2.3-beta.1'], ['1.2.3\n'], ['1.2.3', '2.0.0']]) {
    await assert.rejects(run(args));
    assert.deepEqual(await snapshot(), before);
  }
});

test('a malformed or unexpected package aborts before changing the other packages', async t => {
  const { directory, snapshot, run } = await fixture(t);
  const file = path.join(directory, 'packages/documentation/package.json');
  for (const contents of ['{invalid json', JSON.stringify({ name: 'unexpected-package' })]) {
    await writeFile(file, contents);
    const before = await snapshot();
    await assert.rejects(run(['1.2.3']));
    assert.deepEqual(await snapshot(), before);
  }
});

test('missing documentation aborts before changing package manifests', async t => {
  const { directory, run } = await fixture(t);
  const contents = () => Promise.all(manifests.map(file => readFile(path.join(directory, file), 'utf8')));
  const before = await contents();
  await rm(path.join(directory, 'docs/development.md'));
  await assert.rejects(run(['1.2.3']));
  assert.deepEqual(await contents(), before);
});
