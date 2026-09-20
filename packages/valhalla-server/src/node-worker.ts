import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import createModule from '../../../public/wasm/valhalla.js';
import { instantiateRuntime } from '@tobilg/valhalla-core/runtime';
import { Engine } from '@tobilg/valhalla-core/engine';
import { NODE_WASM_MEMORY } from '@tobilg/valhalla-core/wasm-memory';
import { asError } from '@tobilg/valhalla-core/errors';
import type { ThreadRequest } from './thread-protocol.js';

const port = parentPort!;
let id = 0;
const engine = new Engine(async (memory, maximumBytes) => {
  const compiled = await WebAssembly.compile(await readFile(new URL('./runtime/valhalla.wasm', import.meta.url)));
  return instantiateRuntime(createModule, compiled, memory, maximumBytes);
}, detail => port.postMessage({ type: 'progress', id, detail }), undefined, undefined, NODE_WASM_MEMORY);
let queue = Promise.resolve();
port.on('message', (message: ThreadRequest) => {
  queue = queue.then(async () => {
    id = message.id;
    try {
      const result = message.type === 'initialize' ? await engine.initialize(message.options) :
        message.type === 'route' ? await engine.route(message.request) : await engine.diagnostics();
      port.postMessage({ type: 'result', id, result });
    } catch (error) { port.postMessage({ type: 'error', id, error: asError(error).toJSON() }); }
  });
});
