import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createRangeServer } from '../../scripts/server.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function demoConfig(data = createRangeServer()) {
  const configure = server => {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/manifest.json' || path.startsWith('/datasets/') || path.startsWith('/fixtures/') ||
          /^\/public\/(region|minio|r2)\.json$/.test(path)) void data.handler(req, res);
      else next();
    });
  };
  return defineConfig({
    root: `${root}packages/demo`, publicDir: false, base: './',
    plugins: [{ name: 'graph-range-server', configureServer: configure, configurePreviewServer: configure }],
    server: { host: 'localhost', port: Number(process.env.PORT ?? 8080), strictPort: true, fs: { allow: [root] } },
    preview: { host: 'localhost', port: Number(process.env.PORT ?? 8080), strictPort: true },
    build: { target: 'es2022', outDir: `${root}packages/demo/dist`, emptyOutDir: true },
  });
}
export default demoConfig();
