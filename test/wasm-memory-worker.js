import createModule from '../public/wasm/valhalla.js';
import { probeMemory } from './wasm-memory-probe.js';
self.onmessage = async ({ data }) => {
  try {
    const response = await fetch(new URL('../public/wasm/valhalla.wasm', import.meta.url));
    const compiled = await WebAssembly.compile(await response.arrayBuffer());
    postMessage({ result: await probeMemory(createModule, compiled, data.initialMiB, data.maximumMiB) });
  } catch (error) { postMessage({ error: String(error) }); }
};
