import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// These files are emitted explicitly, avoiding library mode's asset inlining.
// Vite resolves the file references after asset transforms, preserving literal
// new URL(..., import.meta.url) expressions for consuming bundlers and CDNs.
export default defineConfig({
  publicDir: false,
  base: './',
  plugins: [{
    name: 'valhalla-runtime-assets',
    resolveId(id) { if (id === 'virtual:runtime-assets') return '\0runtime-assets'; },
    load(id) {
      if (id !== '\0runtime-assets') return;
      const emit = (fileName: string) => this.emitFile({ type: 'asset', fileName, source: readFileSync(`build/package-runtime/${fileName}`) });
      const worker = emit('worker.js');
      const wasm = emit('valhalla-browser.wasm');
      emit('worker.js.map');
      return `export const workerUrl = import.meta.ROLLUP_FILE_URL_${worker}; export const wasmUrl = import.meta.ROLLUP_FILE_URL_${wasm};`;
    },
  }],
  build: {
    target: 'es2022',
    lib: { entry: 'src/client.ts', formats: ['es'], fileName: () => 'index.js' },
    sourcemap: true,
    outDir: 'dist',
  },
});
