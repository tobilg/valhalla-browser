import createModule from '../../../public/wasm/valhalla.js';
import { instantiateRuntime } from '@tobilg/valhalla-core/runtime';
import { Engine } from '@tobilg/valhalla-core/engine';
import { RoutingError, asError } from './errors.js';
import type { Operations, WorkerRequest, WorkerResponse } from './protocol.js';

const scope = self as DedicatedWorkerGlobalScope;
const respond = (message: WorkerResponse) => scope.postMessage(message);
let queue = Promise.resolve();
let currentId: number;
let wasmUrl: string;
const engine = new Engine(async (memory, maximumBytes) => {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new RoutingError('RUNTIME', `WASM download failed: HTTP ${response.status}.`);
  const compiled = typeof WebAssembly.compileStreaming === 'function' && response.headers.get('content-type')?.split(';')[0].trim() === 'application/wasm'
    ? await WebAssembly.compileStreaming(response) : await WebAssembly.compile(await response.arrayBuffer());
  return instantiateRuntime(createModule, compiled, memory, maximumBytes);
},
  detail => respond({ type: 'progress', id: currentId, detail }));

scope.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  queue = queue.then(async () => {
    currentId = data.id;
    try {
      let result: Operations[keyof Operations]['result'];
      switch (data.type) {
        case 'initialize': wasmUrl = data.options.wasmUrl; result = await engine.initialize(data.options); break;
        case 'route': result = await engine.route(data.request); break;
        case 'diagnostics': {
          const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          result = { ...await engine.diagnostics(), resourceTiming: entries.map(e => ({ name: e.name, durationMs: e.duration,
            transferSize: e.transferSize ?? null, encodedBodySize: e.encodedBodySize ?? null, decodedBodySize: e.decodedBodySize ?? null })) };
          break;
        }
        default: throw new RoutingError('INVALID_REQUEST', 'Unknown worker operation.');
      }
      respond({ id: data.id, type: 'result', result });
    } catch (error) { respond({ id: data.id, type: 'error', error: asError(error).toJSON() }); }
  });
};
respond({ type: 'ready' });
