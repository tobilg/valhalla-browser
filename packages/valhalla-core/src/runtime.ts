import type { RuntimeModule } from './engine.js';

export interface RuntimeOptions {
  wasmMemory: WebAssembly.Memory;
  wasmMaximumBytes: number;
  print: (text: string) => void;
  printErr: (text: string) => void;
  instantiateWasm: (imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => WebAssembly.Exports;
}

/** Host I/O produces a compiled module; the same glue and binary run on every host. */
export function instantiateRuntime(factory: (options: RuntimeOptions) => Promise<RuntimeModule>,
  compiled: WebAssembly.Module, wasmMemory: WebAssembly.Memory, wasmMaximumBytes: number): Promise<RuntimeModule> {
  return factory({ wasmMemory, wasmMaximumBytes, print() {}, printErr() {}, instantiateWasm(imports, receive) {
    const instance = new WebAssembly.Instance(compiled, imports);
    receive(instance, compiled);
    return instance.exports;
  } });
}
