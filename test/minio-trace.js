import { spawn, execFileSync } from 'node:child_process';
import { mcArgs, endpoint } from '../scripts/minio.js';

export async function startTrace() {
  const name = `valhalla-browser-trace-${process.pid}`;
  const args = mcArgs(['admin', 'trace', '--json', '--verbose', 'lab']);
  args.splice(2, 0, '--name', name);
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const records = [];
  let buffer = '', failure;
  child.on('error', error => { failure = error; });
  child.stderr.on('data', () => {});
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record.path?.startsWith('/valhalla/')) continue;
      // Allowlist measurements: never retain request credentials or bodies.
      const h = record.response?.headers ?? {};
      records.push({ path: record.path, at: record.time, method: record.request?.method,
        range: record.request?.headers?.Range ?? null, status: record.response?.statusCode,
        bodyBytes: record.callStats?.tx ?? null, durationNs: record.duration ?? null,
        contentRange: h['Content-Range'] ?? null, contentType: h['Content-Type'] ?? null, etag: h.ETag ?? null,
        cacheControl: h['Cache-Control'] ?? null, contentLength: h['Content-Length'] ?? null });
    }
  });
  const stop = () => {
    try { execFileSync('docker', ['stop', '-t', '1', name], { stdio: 'ignore' }); } catch { /* already exited */ }
    child.kill();
  };
  try {
    for (let n = 0; n < 30; n++) {
      if (failure || child.exitCode !== null) throw failure ?? new Error('MinIO trace exited.');
      await fetch(`${endpoint}/valhalla/manifest.json`, { method: 'HEAD' });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (records.length) return { records, stop, flush: () => new Promise(resolve => setTimeout(resolve, 100)) };
    }
    throw new Error('MinIO trace did not observe the readiness probe.');
  } catch (error) { stop(); throw error; }
}
