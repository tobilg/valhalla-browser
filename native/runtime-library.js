// The shell host's default WASI entropy shim shells out to /dev/urandom.
// All supported hosts provide Web Crypto instead. Override the library symbol at link time,
// without rewriting generated glue or manufacturing shell globals.
addToLibrary({
  // Emscripten's geometric growth must clamp to the instance's cap, otherwise
  // over-reservation can fail even when the requested allocation would fit.
  // WebAssembly.Memory.maximum independently enforces the actual hard limit.
  $getHeapMax: () => Math.min(Module['wasmMaximumBytes'] ?? 1073741824, 1073741824),
  $initRandomFill: () => view => {
    for (let offset = 0; offset < view.byteLength; offset += 65536)
      crypto.getRandomValues(view.subarray(offset, Math.min(offset + 65536, view.byteLength)));
    return 0;
  },
});
