import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import { createRangeServer } from '../scripts/server.js';

export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function corpora() {
  return Promise.all(['fixtures', 'fixtures/region'].map(async directory => ({
    manifest: await json(`${directory}/manifest.json`), reference: await json(`${directory}/reference.json`),
  })));
}
export async function host() {
  const host = createRangeServer({ faults: true });
  host.server.listen(0, 'localhost'); await once(host.server, 'listening');
  return { ...host, base: `http://localhost:${host.server.address().port}`,
    async close() { host.server.closeAllConnections(); await new Promise(resolve => host.server.close(resolve)); } };
}
export const longRoute = corpus => corpus.reference.cases.find(c => c.name === 'balzers-ruggell' || c.name === 'cross-tile');
export async function equivalent(invoke, fixture) {
  let result, error;
  try { result = await invoke(fixture.request); } catch (caught) { error = caught; }
  if (fixture.expected.nativeError === 171 && fixture.name.startsWith('outside')) assert.equal(error?.code, 'OUTSIDE_COVERAGE', fixture.name);
  else if (fixture.expected.nativeError !== undefined) assert.equal(error?.nativeCode, fixture.expected.nativeError, fixture.name);
  else { assert(!error, `${fixture.name}: ${error?.code} ${error?.message}`); assert.deepEqual(result.native, fixture.expected, fixture.name); }
  return result;
}
export const typed = code => error => { assert.equal(error.code, code, error.message); return true; };
export async function report(name, results) {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/${name}.json`, JSON.stringify({ at: new Date().toISOString(), node: process.version,
    device: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, memoryBytes: os.totalmem() },
    runtime: await json('native/runtime-lock.json'), ...results }, null, 2) + '\n');
}
