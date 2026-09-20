// Used in Node, browser workers and workerd against the actual compiled Valhalla.
export async function instantiateTestRuntime(factory, compiled, initialMiB = 64, maximumMiB = 96) {
  const memory = new WebAssembly.Memory({ initial: initialMiB * 16, maximum: maximumMiB * 16 });
  const runtime = await factory({ wasmMemory: memory, wasmMaximumBytes: maximumMiB * 1048576,
    print() {}, printErr() {}, instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiled, imports);
      receive(instance, compiled); return instance.exports;
    } });
  return { memory, runtime };
}

export async function probeMemory(factory, compiled, initialMiB, maximumMiB) {
  const { memory, runtime } = await instantiateTestRuntime(factory, compiled, initialMiB, maximumMiB);
  const initialBytes = memory.buffer.byteLength;
  const allocation = runtime._malloc((maximumMiB - 16) * 1048576);
  const nearCap = runtime._malloc(1048576);
  if (!allocation || !nearCap) throw new Error('An allocation that fits the instance cap failed.');
  const rejected = runtime._malloc(maximumMiB * 1048576);
  if (rejected) throw new Error('Native allocator exceeded the instance cap.');
  const stats = JSON.parse(runtime.ccall('vb_stats', 'string', [], []));
  const peakBytes = memory.buffer.byteLength;
  if (stats.wasmHeapCapacityHighWaterBytes !== peakBytes || peakBytes > maximumMiB * 1048576)
    throw new Error('Native heap is not using the bounded imported memory.');
  runtime._free(nearCap); runtime._free(allocation);
  const recovered = runtime._malloc(1024);
  if (!recovered) throw new Error('Native allocation did not recover after exhaustion.');
  runtime._free(recovered);
  let engineRejected = false;
  try { memory.grow(maximumMiB * 16 - peakBytes / 65536 + 1); }
  catch (error) { engineRejected = error instanceof RangeError; }
  if (!engineRejected) throw new Error('The WebAssembly engine did not enforce the memory cap.');
  return { initialMiB, maximumMiB, initialBytes, peakBytes, nativeAllocationRejected: rejected === 0,
    recovered: true, engineRejected, abi: stats.abi };
}
