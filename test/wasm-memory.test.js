import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWasmMemory, BROWSER_WASM_MEMORY, NODE_WASM_MEMORY, CLOUDFLARE_WASM_MEMORY } from '../packages/valhalla-core/src/wasm-memory.ts';

test('WASM memory defaults and explicit limits are resolved without changing caller input', () => {
  assert.deepEqual(resolveWasmMemory(), { initialMiB: 128, maximumMiB: 512 });
  assert.deepEqual(resolveWasmMemory(undefined, NODE_WASM_MEMORY), { initialMiB: 256, maximumMiB: 512 });
  assert.deepEqual(resolveWasmMemory(undefined, CLOUDFLARE_WASM_MEMORY), { initialMiB: 64, maximumMiB: 96 });
  const input = { initialMiB: 80, maximumMiB: 1024 };
  assert.deepEqual(resolveWasmMemory(input), input);
  assert.notEqual(resolveWasmMemory(input), input);
  for (const defaults of [BROWSER_WASM_MEMORY, NODE_WASM_MEMORY, CLOUDFLARE_WASM_MEMORY]) {
    assert.deepEqual(resolveWasmMemory({ maximumMiB: 1024 }, defaults), { initialMiB: defaults.initialMiB, maximumMiB: 1024 });
    assert.deepEqual(resolveWasmMemory({ initialMiB: 64 }, defaults), { initialMiB: 64, maximumMiB: defaults.maximumMiB });
    assert.deepEqual(resolveWasmMemory({ initialMiB: 64, maximumMiB: 64 }, defaults), { initialMiB: 64, maximumMiB: 64 });
    if (defaults.initialMiB > 64) assert.throws(() => resolveWasmMemory({ maximumMiB: 64 }, defaults), { code: 'INVALID_REQUEST' });
  }
});

test('invalid memory options fail before creating a memory or downloading graph data', () => {
  for (const input of [null, [], true, 1, { maximumBytes: 100 }, { initialMiB: 97, maximumMiB: 96 },
    ...['initialMiB', 'maximumMiB'].flatMap(key => [0, -1, 63, 64.5, 1025, NaN, Infinity, '96', null].map(value => ({ [key]: value }))),
  ]) assert.throws(() => resolveWasmMemory(input), { code: 'INVALID_REQUEST' });
});
