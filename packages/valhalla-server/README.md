# valhalla-server

ESM Valhalla WASM routing for **Node.js 22.22.2+** and **experimental Cloudflare
Workers**. Both compiled runtimes and TypeScript declarations are included.
Graph data stays in object storage and loads on demand; no external routing API
is used. Driving, cycling, walking and truck profiles use the same standard
graphs as `valhalla-browser`.

```js
import { createRouter } from 'valhalla-server/node';

const router = await createRouter({
  // Replace with your immutable dataset URL, and use coordinates it covers.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
});
try {
  const result = await router.route({
    origin: { lat: 47.0666667, lon: 9.5 },
    destination: { lat: 47.2397558, lon: 9.5262874 },
  });
  console.log(result.native);
} finally {
  await router.dispose();
}
```

Import `valhalla-server/node` for a dedicated worker thread, or
`valhalla-server/cloudflare` for a statically imported WASM module with HTTP or
private R2 bindings. The package root exports shared types and `RoutingError`;
it does not select a runtime automatically. Browser applications should use
`valhalla-browser`, including direct CDN loading.

The default per-session queue holds eight waiting operations for up to two
seconds. The overall operation deadline is 30 seconds, including startup and
queue wait. Node active cancellation terminates its thread; Cloudflare uses
cooperative native Asyncify checkpoints. Cloudflare requires the **current
request's execution context on every call**.

Both entry points share one compiled WASM binary. Set
`wasmMemory: { initialMiB: 64, maximumMiB: 96 }` in Router options to configure
the imported linear memory. Defaults are 256 MiB initial and 512 MiB maximum in
Node, or 64 / 96 MiB in Cloudflare. Values must be whole MiB with
`64 <= initialMiB <= maximumMiB <= 1024`. The hard per-instance ceiling includes
native heap, stack and static data; it excludes JavaScript and other isolate
overhead. Increasing it does not raise Cloudflare's platform memory limit.
The effective values are returned in `router.startup.wasmMemory`.

[Server setup, cancellation, limits and R2 guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/server-routing.md) ·
[API documentation](https://valhalla-browser-api.gh.tobilg.com/) ·
[Build compatible graph data](https://github.com/tobilg/valhalla-browser/blob/main/docs/building-graph-data.md)
