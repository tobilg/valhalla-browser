import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { validateTag, integrity, verifyPublished, publishedState } from '../scripts/release.js';

test('stable release tags exactly match the SDK version', () => {
  assert.equal(validateTag('v0.0.1', '0.0.1'), '0.0.1');
  for (const tag of ['v0.0.2', '0.0.1', 'v0.0.1-beta.1', 'v00.0.1', 'v0.0.1\n']) assert.throws(() => validateTag(tag, '0.0.1'));
});
test('publication recovery verifies identity and exact tarball integrity', () => {
  const candidate = { name: 'valhalla-browser', version: '0.0.1', integrity: integrity(Buffer.from('verified candidate')) };
  const metadata = { name: candidate.name, version: candidate.version, dist: { integrity: candidate.integrity } };
  verifyPublished(metadata, candidate);
  for (const changed of [{ ...metadata, name: 'other' }, { ...metadata, version: '0.0.2' }, { ...metadata, dist: { integrity: integrity(Buffer.from('changed')) } }])
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
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert('workflow_dispatch' in workflow.on);
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push'");
  assert.equal(workflow.jobs['deploy-documentation'].if, "github.event_name == 'push'");
  assert(workflow.jobs['deploy-documentation'].needs.includes('publish'));
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  const serialized = JSON.stringify(workflow);
  assert(!serialized.includes('NPM_TOKEN') && !serialized.includes('NODE_AUTH_TOKEN'));
  assert(serialized.includes('valhalla-browser-api'));
});
