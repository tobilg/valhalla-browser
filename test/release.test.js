import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { validateTag, integrity, verifyPublished, publishedState } from '../scripts/release.js';

test('stable release tags exactly match the SDK version', () => {
  assert.equal(validateTag('v0.0.1', '0.0.1'), '0.0.1');
  for (const tag of ['v0.0.2', '0.0.1', 'v0.0.1-beta.1', 'v00.0.1', 'v0.0.1\n']) assert.throws(() => validateTag(tag, '0.0.1'));
});
test('publication recovery verifies identity and exact tarball integrity', () => {
  const candidate = { name: 'valhalla-browser', version: '0.0.1', integrity: integrity(Buffer.from('verified candidate')) };
  const metadata = { name: candidate.name, version: candidate.version, dist: { integrity: candidate.integrity } };
  verifyPublished(metadata, candidate);
  for (const changed of [{ ...metadata, name: 'other' }, { ...metadata, version: '0.1.0' }, { ...metadata, dist: { integrity: integrity(Buffer.from('changed')) } }])
    assert.throws(() => verifyPublished(changed, candidate));
});
test('only authoritative npm 404 means unpublished; registry errors cannot permit publication', async () => {
  const candidate = { name: 'valhalla-browser', version: '0.0.1', integrity: 'sha512-example' };
  assert.equal(await publishedState(candidate, async () => new Response('', { status: 404 })), false);
  assert.equal(await publishedState(candidate, async () => Response.json({ name: candidate.name, version: candidate.version, dist: { integrity: candidate.integrity } })), true);
  for (const status of [401, 403, 429, 500]) await assert.rejects(() => publishedState(candidate, async () => new Response('', { status })));
  await assert.rejects(() => publishedState(candidate, async () => { throw new Error('Network unavailable'); }));
});
test('manual release runs cannot publish or deploy, and production deployment depends on publication', async () => {
  const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  assert('workflow_dispatch' in workflow.on);
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push'");
  for (const name of ['deploy-documentation', 'deploy-demo']) {
    assert.equal(workflow.jobs[name].if, "github.event_name == 'push'");
    assert.deepEqual(workflow.jobs[name].needs, ['verify', 'publish']);
  }
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  const serialized = JSON.stringify(workflow);
  assert(!serialized.includes('NPM_TOKEN') && !serialized.includes('NODE_AUTH_TOKEN'));
  assert(serialized.includes('valhalla-browser-api'));
});

test('demo deployment consumes the verified artifact and targets its own Pages project', async () => {
  const proof = parse(await readFile('.github/workflows/browser-proof.yml', 'utf8'));
  const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
  const uploads = proof.jobs['source-build-and-proof'].steps;
  const upload = uploads.find(step => step.uses?.startsWith('actions/upload-artifact@') && step.with.name === 'demo');
  assert.equal(upload.with.path, 'packages/demo/dist/');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert(uploads.indexOf(upload) > uploads.findIndex(step => step.run === 'pnpm run test:demo --preview --minio'));
  const build = uploads.find(step => step.name === 'Build demo with the public R2 manifest');
  const check = uploads.find(step => step.name === 'Verify configured demo artifact');
  assert.equal(build.env.VITE_DEMO_MANIFEST_URL, '${{ vars.VITE_DEMO_MANIFEST_URL }}');
  assert.equal(build.if, "vars.VITE_DEMO_MANIFEST_URL != ''");
  assert.deepEqual(check.env, build.env);
  assert.equal(check.if, build.if);
  assert.equal(check.run, 'pnpm run test:demo:static --artifact');
  assert(uploads.indexOf(build) > uploads.findIndex(step => step.run === 'pnpm run test:matrix'));
  assert(uploads.indexOf(check) > uploads.indexOf(build));
  assert(uploads.indexOf(upload) > uploads.indexOf(check));
  const required = workflow.jobs.validate.steps.find(step => step.name === 'Require the deployed demo manifest URL');
  assert.equal(required.if, "github.event_name == 'push'");
  assert.deepEqual(required.env, build.env);
  const steps = workflow.jobs['deploy-demo'].steps;
  const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, 'packages/demo/dist');
  const deploy = steps.find(step => step.run?.includes('wrangler pages deploy'));
  assert.match(deploy.run, /pages deploy dist --cwd \.\.\/demo --project-name valhalla-browser --branch main/);
  assert(!steps.some(step => /pnpm run build/.test(step.run ?? '')), 'Deploy the tested build without rebuilding');
});

test('tagged releases reject missing or invalid demo URLs before verification', async () => {
  const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
  const guard = workflow.jobs.validate.steps.find(step => step.name === 'Require the deployed demo manifest URL');
  for (const value of ['', '  ', 'not-a-url', 'http://example.com/manifest.json', 'https://user:pass@example.com/manifest.json',
    'https://routing.example.com/datasets/liechtenstein-2015/manifest.json']) {
    const result = spawnSync('bash', ['-c', guard.run], { encoding: 'utf8', env: { ...process.env, VITE_DEMO_MANIFEST_URL: value } });
    assert.equal(result.status, value.startsWith('https://routing.example.com/') ? 0 : 1, result.stderr);
  }
});
