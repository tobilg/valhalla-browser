import { Router, RoutingError, type RouteRequest } from 'valhalla-server/cloudflare';

let router: Router | undefined;
async function body(request: Request): Promise<RouteRequest> {
  const reader = request.body?.getReader();
  if (!reader) throw new RoutingError('INVALID_REQUEST', 'A JSON route request is required.');
  const bytes = new Uint8Array(16384);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) throw new RoutingError('INVALID_REQUEST', 'Request exceeds 16 KiB.');
      bytes.set(value, length); length += value.length;
    }
    try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
    catch { throw new RoutingError('INVALID_REQUEST', 'Invalid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export default {
  async fetch(request, env, context) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/route')
      return new Response('POST /route', { status: 404 });
    try {
      // Add your authentication/rate limiting before exposing a public endpoint.
      router ??= new Router({
        source: { type: 'r2', bucket: env.GRAPH_DATA, manifestKey: env.MANIFEST_KEY },
        // Cloudflare defaults; JavaScript and transfer buffers need memory too.
        wasmMemory: { initialMiB: 64, maximumMiB: 96 },
      });
      const result = await router.route(await body(request), { context, signal: request.signal });
      return Response.json(result.native, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const typed = error instanceof RoutingError ? error : new RoutingError('RUNTIME', 'Routing failed.');
      const status = ['QUEUE_FULL', 'QUEUE_TIMEOUT'].includes(typed.code) ? 503 : typed.code === 'TIMEOUT' ? 504 :
        typed.code === 'CANCELLED' ? 499 : ['INVALID_REQUEST', 'UNSUPPORTED_COSTING', 'OUTSIDE_COVERAGE'].includes(typed.code) ? 400 :
        ['NO_ROUTE', 'LOCATION_NOT_FOUND'].includes(typed.code) ? 404 : 500;
      return Response.json({ error: typed.toJSON() }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
  },
} satisfies ExportedHandler<Env>;
