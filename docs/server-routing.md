---
title: Node.js and Cloudflare Workers
---

# Node.js and Cloudflare Workers

`valhalla-browser` runs in a dedicated browser Web Worker and retains its existing
API and CDN entry points. `valhalla-server` provides explicit ESM adapters:

| Import | Execution host | Graph delivery |
| --- | --- | --- |
| `valhalla-browser` | Browser Web Worker | HTTP indexed TAR or individual tiles |
| `valhalla-server/node` | Dedicated Node worker thread | HTTP indexed TAR or individual tiles |
| `valhalla-server/cloudflare` | Experimental workerd/WASM actor | HTTP or private R2 binding, either tile layout |
| `valhalla-server` | Shared types and `RoutingError` only | No automatic host selection |

Install `pnpm add valhalla-server`. No native compilation occurs during package
installation. Both WASM variants and their notices ship inside the package.
The private workspace package `@tobilg/valhalla-core` is bundled into each public
package; consumers never need to install it. Types also ship self-contained.

## Node.js

Use Node 22.22.2 or later. This example uses coordinates from the historical
Liechtenstein fixture; use coordinates inside your own graph's coverage.

```ts
import { Router } from 'valhalla-server/node';

const router = new Router({
  // Replace this complete placeholder with your immutable manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
  transport: 'indexed-tar',
});
const controller = new AbortController();
try {
  const result = await router.route({
    origin: { lat: 47.0666667, lon: 9.5 },
    destination: { lat: 47.2397558, lon: 9.5262874 },
    costing: 'bicycle',
  }, { signal: controller.signal });
  console.log(result.native);
} finally {
  await router.dispose();
}
```

Keep one router for repeated requests to reuse the decoded-tile cache. Each
router has one worker thread and actor. An active abort terminates that thread
and waits for termination before admitting queued callers on a replacement.
Aborting a queued call removes only that call. `await router.cancel()` cancels
all current and queued operations; a later route can initialize a new thread.
`dispose()` closes the session permanently. Do not make one router per request
unless the loss of cache reuse and additional memory are intentional.

## Experimental Cloudflare Workers

Cloudflare is a separate runtime target, not the browser package running behind
a shim. It statically imports WASM and instantiates the precompiled module through
Emscripten's `instantiateWasm` hook. A link-time entropy provider uses Web Crypto.
It does not depend on browser Workers, `node:worker_threads`, or dynamic WASM
compilation. Node compatibility can remain enabled in your application.

The complete local example is in
[`examples/cloudflare`](https://github.com/tobilg/valhalla-browser/tree/main/examples/cloudflare).
Its Wrangler configuration is illustrative; replace the bucket name and manifest
key before deploying. The demo and API documentation continue to use Pages.

```ts
import { Router } from 'valhalla-server/cloudflare';

// Cache the session/capability, never a Request, Response, stream or I/O promise.
let router: Router | undefined;

export default {
  async fetch(request, env, context) {
    router ??= new Router({
      source: {
        type: 'r2',
        bucket: env.GRAPH_DATA,
        manifestKey: 'datasets/your-release-id/manifest.json', // replace
      },
    });
    const result = await router.route({
      origin: { lat: 47.0666667, lon: 9.5 },
      destination: { lat: 47.2397558, lon: 9.5262874 },
    }, { context, signal: request.signal });
    return Response.json(result.native);
  },
} satisfies ExportedHandler<Env>; // Env is generated with wrangler types
```

For public object storage, replace `source` with
`{ type: 'http', manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json' }`
and supply your real URL. Direct binding reads require no public bucket URL,
browser CORS policy, storage access key or HTTP cache headers. They still require
the manifest's **actual R2 ETags**, total sizes and unchanged SHA-256 checksums.
R2 ETags are opaque validators; they are not SHA-256 hashes. Use the existing
dataset ETag preparation workflow for public objects or write the uploaded
objects' quoted `httpEtag` values into the archive and tile manifest entries.
Only delivery validators change; do not change graph identity or checksums.

R2 manifests must use relative config/archive paths within one immutable version
prefix. The adapter validates conditional get results, returned range metadata,
object size/ETag and the graph bytes. Offsets remain `bigint` until checked for
safe conversion to the binding's numeric API. R2 has no abortable `get`; after
cancellation the adapter waits for it to settle and discards the body before
allowing another native operation. A deadline is cooperative, not a hard promise
that an uninterruptible platform read or native section ends at that instant.

## Admission and cancellation

Cloudflare may overlap several asynchronous requests in one isolate. Autoscaling
does not make a shared actor reentrant. Both server adapters use a bounded FIFO:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxQueuedRoutes` | 8 | Waiting operations beyond the active call; 0 rejects immediately |
| `queueTimeoutMs` | 2,000 | Maximum admission wait |
| `routeTimeoutMs` | 30,000 | Whole operation deadline, including queue and initialization |
| `timeoutMs` | 10,000 | Per graph/metadata fetch timeout |
| `retries` | 2 | Additional transient-fetch attempts |
| `memoryBudgetBytes` | 33,554,432 | Retained decoded tiles, not total memory |
| `wasmMemory.initialMiB` | 256 Node / 64 Cloudflare | Initial WASM linear-memory allocation |
| `wasmMemory.maximumMiB` | 512 Node / 96 Cloudflare | Per-instance hard WASM growth ceiling |
| `searchMemory.astar` | 16,384 | Initial A* label reservation, not a search limit |
| `searchMemory.bidirectionalAstar` | 16,384 | Initial bidirectional A* reservation |
| `searchMemory.clearReservedMemory` | false | Reuse search storage between calls |

Initialization and diagnostics use the same admission gate. `QUEUE_FULL` and
`QUEUE_TIMEOUT` are retryable admission errors. Applications should apply bounded
backoff or return 503; do not retry indefinitely inside the same request.

Each Cloudflare call must receive its own `{ context, signal }`. Admission passes
only a permit: the caller performs its own I/O in its own async context. There is
no global initialization promise shared between requests. A native interrupt
callback suspends with Asyncify, yields with `scheduler.wait(0)` and checks the
caller signal/deadline. The actor's cleanup finishes before the next permit is
released. `context.waitUntil` keeps settlement/cleanup alive on disconnect, within
the platform's lifetime limits; it cannot override isolate eviction or CPU limits.
Do not dispose a shared router at the end of each successful request.

`CANCELLED` differs from a transient `NETWORK`/`TIMEOUT`, an authoritative
`INCOMPLETE_DATASET`, or a native no-route result. Failed downloads must not be
interpreted as absent tiles. Fatal runtime failures replace the engine before
the next admitted operation. A platform-killed isolate cannot recover in place;
a later request needs a fresh isolate. Runtime replacement drops references to the
old WASM instance, but cannot force immediate garbage collection; transient total
memory during replacement also needs deployed validation.

## Resource and deployment limits

All hosts use one ABI-3 WASM binary compiled with imported memory and a
1,024 MiB upper ceiling. Each instance receives its own `WebAssembly.Memory`.
Defaults are 128 MiB initial / 512 MiB maximum for browsers,
256 MiB initial / 512 MiB maximum for Node, and 64 MiB initial / 96 MiB maximum
for Cloudflare. Configure them with:

```ts
// Include in either Node or Cloudflare Router options.
wasmMemory: { initialMiB: 64, maximumMiB: 96 }
```

Both values must be whole MiB, with `64 <= initialMiB <= maximumMiB <= 1024`.
Omitted values use the host defaults independently; when setting a maximum below
the default initial allocation, also set `initialMiB` to fit that maximum.
Invalid settings reject with `INVALID_REQUEST`; the selected values appear in
`router.startup.wasmMemory`. The maximum is fixed for that WASM instance. Create
a new Cloudflare Router to change it; browser/Node changes take effect after
worker/thread replacement. Raising the maximum does not allocate it immediately.

The cap covers native heap, stack and static data. Emscripten's growth policy is
clamped to the same cap so geometric over-reservation cannot reject an allocation
that would fit. Native allocation exhaustion becomes `RESOURCE_LIMIT`; the host
replaces the runtime before the next operation. This does not impose a total
process/isolate cap or guarantee that the platform can allocate the full allowance.
The remaining
isolate budget must also cover JavaScript, metadata, graph transfer buffers,
responses and runtime overhead. A bounded tile cache does not bound search memory.
Regional success is not evidence of safe country/planet routing or a supported
production request rate. Cooperative checkpoints occur at Valhalla's existing
interrupt sites, not at every instruction. Large gaps can still hit CPU limits.

Cloudflare timings that its clock cannot measure reliably are returned as `null`:
startup/route/queue time, sequential wait, trace elapsed time and browser resource
timing. Counters, validated bytes, cache hits and WASM heap capacity remain useful.
Heap capacity is neither live allocation nor total isolate RSS. Use external
client wall time and Cloudflare platform CPU/memory telemetry for deployed tests.

Before exposing a routing endpoint, pin your graph/config, authenticate and rate
limit callers as appropriate, bound input/response sizes and select paid-plan CPU
limits based on measurements. The example emits no route coordinates to telemetry.
No Cloudflare deployment or production capacity claim is part of the local proof.

## Build and verify

```sh
pnpm install --frozen-lockfile
pnpm run build:wasm      # pinned Emscripten 6.0.0; one shared binary for all hosts
pnpm run build:sdks
pnpm run test:server:node
pnpm run test:server:cloudflare  # local workerd + real Miniflare R2 binding
pnpm run pack:server
pnpm run test:server:package    # isolated consumers + Wrangler dry-run, no upload
pnpm run benchmark:server
```

Prepare the native fixtures first with `pnpm run build:native`, `pnpm run data`
and `pnpm run data:region` if absent. Tests compare complete native responses,
without geometry or timing tolerances, for the existing two graph corpora and all
four profiles. Reports are generated under `test-results/`. The benchmark uses
five cold sessions and twenty warm repetitions per profile/backend; local R2
measurements are not CDN or deployed-platform results.

See the [local verification and benchmark report](https://github.com/tobilg/valhalla-browser/blob/main/docs/server-verification.md) for measured
results and provisional regression budgets.

Platform references: [WASM](https://developers.cloudflare.com/workers/runtime-apis/webassembly/),
[R2 binding semantics](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
