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
`wasmHeapCapacityHighWaterBytes` is linear-memory capacity, not live allocation
or process RSS. The tested historical regional graph uses about 166 MiB capacity
with this runtime even though its tile payload is about 1.5 MB.

A same-worker repeated route can make zero loader requests. That is separate from
browser HTTP-cache reuse and CDN cache status. Browser 206 caching is not a
cross-browser guarantee. Resource Timing zeros on a cross-origin response without
Timing-Allow-Origin do not prove that no bytes transferred. Missing transfer data
must remain unknown. CF-Cache-Status may itself be replayed from browser cache.

The SDK has no telemetry. Explicit diagnostics contain tile URLs/IDs; applications
should choose what to record and avoid including user route coordinates by default.

Run the [benchmark commands](https://github.com/tobilg/valhalla-browser/blob/main/docs/development.md)
for your graph, browsers and network. Historical measurements are engineering
baselines, not approved performance budgets or production coverage claims.
