import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
    plugins: [{
      name: 'graph-range-server', configureServer: configure, configurePreviewServer: configure,
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'leaflet-LICENSE.txt',
          source: readFileSync(new URL('../LICENSE', import.meta.resolve('leaflet')), 'utf8') });
      },
      configResolved(config) {
        for (const name of ['VITE_DEMO_MANIFEST_URL', 'VITE_DEMO_BASEMAP_URL']) {
          const value = config.env[name]?.trim();
          if (!value) continue;
          let url;
          try { url = new URL(value); } catch { /* Report the setting, not its contents. */ }
          if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
            throw new Error(`${name} must be an absolute public HTTP(S) URL without credentials.`);
          if (name === 'VITE_DEMO_BASEMAP_URL' && !['{z}', '{x}', '{y}'].every(part => value.includes(part)))
            throw new Error('VITE_DEMO_BASEMAP_URL must include {z}, {x}, and {y} tile coordinates.');
        }
      },
    }],
    server: { host: 'localhost', port: Number(process.env.PORT ?? 8080), strictPort: true, fs: { allow: [root] } },
    preview: { host: 'localhost', port: Number(process.env.PORT ?? 8080), strictPort: true },
    build: { target: 'es2022', outDir: `${root}packages/demo/dist`, emptyOutDir: true },
  });
}
export default demoConfig();
