import { RoutingError } from './errors.js';
import type { EffectiveWasmMemory } from './types.js';

export const WASM_MINIMUM_INITIAL_MIB = 64;
export const WASM_MAXIMUM_MIB = 1024;
export const BROWSER_WASM_MEMORY: EffectiveWasmMemory = Object.freeze({ initialMiB: 128, maximumMiB: 512 });
export const NODE_WASM_MEMORY: EffectiveWasmMemory = Object.freeze({ initialMiB: 256, maximumMiB: 512 });
export const CLOUDFLARE_WASM_MEMORY: EffectiveWasmMemory = Object.freeze({ initialMiB: 64, maximumMiB: 96 });

export function resolveWasmMemory(input?: unknown, defaults: EffectiveWasmMemory = BROWSER_WASM_MEMORY): EffectiveWasmMemory {
  const invalid = () => { throw new RoutingError('INVALID_REQUEST', 'wasmMemory requires integer MiB values: 64 <= initialMiB <= maximumMiB <= 1024.'); };
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return invalid();
  const options = (input ?? {}) as Record<string, unknown>;
  if (Object.keys(options).some(key => !['initialMiB', 'maximumMiB'].includes(key))) return invalid();
  const initialMiB = options.initialMiB === undefined ? defaults.initialMiB : options.initialMiB;
  const maximumMiB = options.maximumMiB === undefined ? defaults.maximumMiB : options.maximumMiB;
  if (typeof initialMiB !== 'number' || typeof maximumMiB !== 'number' ||
      !Number.isInteger(initialMiB) || !Number.isInteger(maximumMiB) ||
      initialMiB < WASM_MINIMUM_INITIAL_MIB || initialMiB > maximumMiB || maximumMiB > WASM_MAXIMUM_MIB) return invalid();
  return { initialMiB, maximumMiB };
}

export function createWasmMemory(options: EffectiveWasmMemory): WebAssembly.Memory {
  try {
    return new WebAssembly.Memory({ initial: options.initialMiB * 16, maximum: options.maximumMiB * 16 });
  } catch (cause) {
    throw new RoutingError('RESOURCE_LIMIT', 'Cannot allocate the requested WASM memory.', { cause });
  }
}
