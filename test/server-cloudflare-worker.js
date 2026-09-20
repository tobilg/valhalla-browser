import createModule from '../public/wasm/valhalla.js';
import compiled from '../public/wasm/valhalla.wasm';
import { probeMemory } from './wasm-memory-probe.js';
import { Router } from '../packages/valhalla-server/dist/cloudflare.js';

// Test-only handler: production applications must validate/authenticate their
// own endpoint, pin a dataset and bound request bodies (see docs/server-routing).
let router;
let abortAtCheckpoint;
export default {
  async fetch(request, env, context) {
    const input = await request.json();
    const controller = new AbortController();
    const timer = input.abortMs === undefined ? undefined : setTimeout(() => controller.abort(), input.abortMs);
    const operation = { context, signal: controller.signal };
    try {
      if (input.command === 'memory-probe') return Response.json({ result: await probeMemory(createModule, compiled, input.initialMiB, input.maximumMiB) });
      if (input.command === 'reset') {
        if (router) await router.dispose({ context });
        const bucket = input.options.r2DelayMs ? {
          async get(...args) { await scheduler.wait(input.options.r2DelayMs); return env.GRAPH_DATA.get(...args); },
          head: env.GRAPH_DATA.head.bind(env.GRAPH_DATA),
        } : env.GRAPH_DATA;
        router = new Router({ ...input.options, source: input.options.source.type === 'r2'
          ? { ...input.options.source, bucket } : input.options.source,
        onProgress(event) { if (event.phase === 'routing' && abortAtCheckpoint) setTimeout(() => abortAtCheckpoint?.abort(), 0); } });
        return Response.json({ result: true });
      }
      if (input.command === 'initialize') return Response.json({ result: await router.initialize(operation) });
      if (input.command === 'dispose') { await router.dispose({ context }); return Response.json({ result: true }); }
      if (input.command === 'diagnostics') return Response.json({ result: await router.diagnostics(operation) });
      if (input.abortAtCheckpoint) abortAtCheckpoint = controller;
      return Response.json({ result: await router.route(input.request, operation) });
    } catch (error) {
      return Response.json({ error: { code: error.code, message: error.message, nativeCode: error.nativeCode, retryable: error.retryable } });
    } finally { if (timer !== undefined) clearTimeout(timer); if (abortAtCheckpoint === controller) abortAtCheckpoint = undefined; }
  },
};
