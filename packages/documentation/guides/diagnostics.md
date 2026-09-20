---
title: Diagnostics and memory
---

# Diagnostics and memory

Startup results separate module initialization, graph startup and host-observed
worker readiness. Per-route diagnostics include route time, host time, tile
requests/bytes, sequential fetch wait, decoded-cache hits and native statistics.
`router.diagnostics()` adds accumulated counters, tile traces and resource timing.

The default decoded-tile budget is 32 MiB. Its hard LRU limit bounds retained
tiles, not live references, routing search allocations or total worker memory.
The budget must fit the largest individual tile listed in the manifest; a smaller
budget rejects initialization with `INVALID_REQUEST` instead of a false routing failure.

## Search-label reservations

Valhalla also allocates labels while searching the graph. `RouterOptions.searchMemory`
controls their initial reservation independently of the decoded-tile cache:

```ts
import { createRouter } from 'valhalla-browser';

const router = await createRouter({
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
  searchMemory: {
    astar: 16_384,
    bidirectionalAstar: 16_384,
    clearReservedMemory: false,
  },
});
console.log(router.startup?.searchMemory, router.startup?.effectiveConfigSha256);
await router.dispose();
```

These are the SDK defaults. Each count accepts an integer from zero to 2,000,000;
zero starts without preallocated label storage. The bidirectional value applies
to **each** direction. Single-direction A* is also used for some short routes,
so both settings matter even without time-dependent routing. Omitted fields use
SDK defaults; invalid values reject with `INVALID_REQUEST` before dataset loading.

Reservations are not expansion limits. Vectors can grow during a search and native
cleanup can reduce them afterwards. Smaller reservations may require reallocations
on larger searches. `clearReservedMemory: true` asks Valhalla to release used label
storage after each route for allocator reuse. It retains decoded tiles, but does
not shrink WASM linear memory and may cause more allocation work on later routes.
The default `false` keeps modest reusable reservations.

These settings override the dataset's A* reservation and cleanup fields when the
actor initializes. They do not alter costing, hierarchy limits, or graph bytes.
Changing them requires a new initialization (a new Router, or worker replacement
after `cancel()`). There is no need to rebuild WASM or re-upload graph data.
The SDK does not expose matrix/isochrone reservation settings for its route-only API.

Startup reports resolved `searchMemory`. `configSha256` remains the hash of the
validated source configuration. `effectiveConfigSha256` hashes the JSON passed
to the native actor, including resolved tile URLs, cache settings, and reservation
overrides; a different origin or local port can therefore change that hash.
Route results include both hashes in `dataset` for reproducible diagnostics.

## Memory measurements and cache state

`wasmHeapCapacityHighWaterBytes` is linear-memory capacity, not live allocation
or process RSS. The earlier search-reservation benchmark used 64 MiB initial
memory; both fixed native-reference corpora stayed within that allocation in
Chromium, Firefox and WebKit.
The previous reservations reached about 166 MiB on the longer regional route and
314 MiB across its corpus, despite only about 1.5 MB of regional tile payload.
See the [reservation investigation](https://github.com/tobilg/valhalla-wasm/blob/main/docs/search-memory.md)
for exact configurations, timings, and reproduction commands. Larger graphs can
still grow beyond 64 MiB. Neither reservation counts nor `memoryBudgetBytes`
bound total worker memory. `wasmMemory` separately controls the hard linear-memory
ceiling, with defaults of 128 MiB initial / 512 MiB maximum in browsers,
256 / 512 MiB in Node, or 64 / 96 MiB in Cloudflare. The shared binary supports up to 1,024 MiB. Supply
whole-MiB values with `64 <= initialMiB <= maximumMiB <= 1024`, for example
`wasmMemory: { initialMiB: 64, maximumMiB: 128 }` for a browser session.
`startup.wasmMemory` reports the resolved settings. This ceiling includes native
heap, stack and static data, but excludes JavaScript, transfer buffers and runtime
overhead; it does not increase Cloudflare's isolate limit. Allocation exhaustion
returns `RESOURCE_LIMIT` and the next operation uses a fresh runtime.

A same-worker repeated route can make zero loader requests. That is separate from
browser HTTP-cache reuse and CDN cache status. Browser 206 caching is not a
cross-browser guarantee. Resource Timing zeros on a cross-origin response without
Timing-Allow-Origin do not prove that no bytes transferred. Missing transfer data
must remain unknown. CF-Cache-Status may itself be replayed from browser cache.

The SDK has no telemetry. Explicit diagnostics contain tile URLs/IDs; applications
should choose what to record and avoid including user route coordinates by default.

Run the [benchmark commands](https://github.com/tobilg/valhalla-wasm/blob/main/docs/development.md)
for your graph, browsers and network. Historical measurements are engineering
baselines, not approved performance budgets or production coverage claims.
