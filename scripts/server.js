import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function createRangeServer({ faults = false } = {}) {
  const records = [];
  let fault = null;
  const validators = new Map();
  const handler = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag, Last-Modified, Accept-Ranges');
    res.setHeader('Timing-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Routing test host</title>'); return; }
      if (!/^\/(dist|public|datasets|fixtures)\//.test(pathname) && pathname !== '/manifest.json' && !(faults && pathname.startsWith('/test/'))) { res.writeHead(404); res.end(); return; }
      if (pathname.startsWith('/datasets/') || pathname === '/manifest.json') pathname = `/public${pathname}`;
      const file = path.resolve(root, pathname.startsWith('/dist/') ? `packages/valhalla-browser${pathname}` : `.${pathname}`);
      if (!file.startsWith(root) || pathname.split('/').includes('..')) { res.writeHead(403); res.end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404); res.end(); return; }
      if (!Number.isSafeInteger(info.size)) { res.writeHead(501); res.end('Object exceeds local server offset precision.'); return; }
      let validator = validators.get(file);
      if (!validator || validator.mtime !== info.mtimeMs) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        validator = { mtime: info.mtimeMs, etag: `"${hash.digest('hex')}"` };
        validators.set(file, validator);
      }
      const immutable = pathname.startsWith('/public/datasets/');
      res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.setHeader('ETag', validator.etag);
      res.setHeader('Last-Modified', info.mtime.toUTCString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
        if (!match || BigInt(match[1]) > BigInt(match[2]) || BigInt(match[2]) >= BigInt(info.size)) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
        }
        start = Number(match[1]); end = Number(match[2]); status = 206;
      }
      const record = { path: url.pathname, method: req.method, range: req.headers.range ?? null, status, bodyBytes: 0, at: Date.now() };
      records.push(record);
      const active = faults && fault && (!fault.match || url.pathname.includes(fault.match)) && (!fault.tileOnly || (start > 512 || pathname.endsWith('.gph'))) ? fault : null;
      if (active && --active.remaining <= 0) fault = null;
      if (active) record.fault = active.type;
      if (active) res.setHeader('Cache-Control', 'no-store');
      if (active?.delayMs) await new Promise(resolve => setTimeout(resolve, active.delayMs));
      if (req.destroyed) return;
      if (active?.type === 'transient') { record.status = 503; res.writeHead(503); res.end(); return; }
      if (active?.type === 'missing') { record.status = 404; res.writeHead(404); res.end(); return; }
      if (active?.type === 'denied') { record.status = 403; res.writeHead(403); res.end(); return; }
      if (active?.type === 'drop') { res.destroy(); return; }
      if (active?.type === 'ignore-range') { status = 200; start = 0; end = info.size - 1; }
      if (status === 206) res.setHeader('Content-Range', `bytes ${active?.type === 'wrong-range' ? start + 1 : start}-${end}/${info.size}`);
      if (active?.type === 'mismatch') res.setHeader('ETag', '"changed"');
      res.setHeader('Content-Length', end - start + 1);
      record.status = status;
      if (req.headers['if-none-match'] === validator.etag && !req.headers.range) { record.status = 304; res.writeHead(304); res.end(); return; }
      res.writeHead(status);
      if (req.method === 'HEAD') { res.end(); return; }
      if (active?.type === 'corrupt') {
        const bytes = (await readFile(file)).subarray(start, end + 1);
        bytes[bytes.length - 1] ^= 255;
        record.bodyBytes += bytes.length;
        res.end(bytes); return;
      }
      if (active?.type === 'truncated') {
        const bytes = await readFile(file);
        const partial = bytes.subarray(start, Math.max(start, end - 10));
        record.bodyBytes += partial.length;
        res.end(partial);
        return;
      }
      const stream = createReadStream(file, { start, end });
      stream.on('data', chunk => { record.bodyBytes += chunk.length; });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
  };
  const server = http.createServer(handler);
  return { server, handler, records, setFault: spec => { if (!faults) throw new Error('Fault injection disabled.'); fault = spec ? { remaining: 1, ...spec } : null; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createRangeServer();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, '127.0.0.1', () => console.log(`Valhalla range/test host: http://127.0.0.1:${port}`));
}
