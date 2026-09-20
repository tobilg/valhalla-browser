# Search-label reservations: investigation and defaults

Measured on 20 September 2026. The SDK now reserves **16,384 labels per A* search
vector**, instead of inheriting the fixture configurations' 2,000,000 for
single-direction A* and 1,000,000 **per direction** for bidirectional A*.
The setting is configurable through `RouterOptions.searchMemory`.

The unchanged WASM stayed at its 64 MiB initial linear-memory allocation across
both complete native-reference corpora in Chromium, Firefox and WebKit. Previously,
a cold Balzers–Ruggell route reached about 166 MiB, and the complete regional
corpus reached 314 MiB. This is a reduction in allocated WASM capacity; JavaScript
memory, process RSS and peak live allocator usage were not measured.

## What the pinned source does

The inspected source is Valhalla 3.8.3 at
`a60c7cbfc83e073f50887cd27e0109d02e6b64e5`, checked out in `build/sources/valhalla`.

- [BidirectionalAStar](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/thor/bidirectional_astar.cc)
  reads `thor.max_reserved_labels_count_bidir_astar` and calls `reserve()` on both
  forward and reverse vectors when a search initializes.
- [UnidirectionalAStar](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/thor/unidirectional_astar.cc)
  reserves up to `thor.max_reserved_labels_count_astar` (capped upstream at
  2,000,000 for its initial allocation).
- [Route algorithm selection](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/thor/route_action.cc)
  uses bidirectional A* for ordinary road routes and single-direction A* for
  some same/connected-edge cases, even without a date/time. Reducing only the
  bidirectional reservation leaves the other large allocation possible.
- `Clear()` uses the configured reservation as a cleanup target, or zero when
  `clear_reserved_memory` is true. The vectors still grow as needed during a
  search. Cleanup is not a strict capacity cap: its shrink condition checks used
  size. Returning storage to the C++ allocator does not shrink WASM linear memory.

The actor already performs native cleanup after operations. No C++ patch, ABI
change, WASM rebuild, graph rebuild, or hosted-object replacement is needed.
The SDK overrides the two A* fields and cleanup policy in its effective runtime
configuration. It leaves Dijkstra/matrix settings alone; those operations are
not exposed by this route-only API.

## Policy and API

```ts
const router = new Router({
  manifestUrl,
  searchMemory: {
    astar: 16_384,
    bidirectionalAstar: 16_384,
    clearReservedMemory: false,
  },
});
```

The shown values are defaults, so the option can be omitted. Counts accept
integers from 0 to 2,000,000; zero allows entirely demand-grown label storage.
Each omitted field uses its SDK default. Invalid settings reject before metadata
or WASM loading. Settings take effect when the actor initializes and survive
cancellation/recreation of its worker.

16,384 is a provisional balance: a modest reusable allocation without assuming
million-label searches. An exploratory Chromium sweep tested zero, 4,096, 16,384,
and 65,536 reservations; every smaller setting stayed at the 64 MiB floor and
matched the native corpus. That metric cannot distinguish their actual live
allocations below the floor, nor establish a universally optimal reservation.
The initial sweep changed all four upstream reservation fields together; the
public-API verification below confirms that changing only the two A* fields is
sufficient for these routes.

Clearing reservations while retaining the previous large counts did **not**
reduce the first long route's roughly 166 MiB peak. Keeping cleanup disabled
with small reservations avoids deliberately freeing/reallocating the vectors on
every route. It does not retain an unbounded search result: upstream cleanup
still applies. Larger searches can allocate more storage regardless of this option.

`initialize()` reports the resolved `searchMemory` and `effectiveConfigSha256`.
The latter hashes the actual native initialization JSON, including resolved tile
URLs, cache settings and search overrides. It consequently changes with a local
server port or deployment origin. `configSha256` continues to identify the
unchanged, validated dataset configuration. Routes carry both hashes in `dataset`.

## Verification actually run

The two corpora are:

| Dataset | Cases | Source configuration SHA-256 |
| --- | ---: | --- |
| `fixture-v1-d087a2c15b9dc394` | 43 | `ff64cf8154ad8632a32bb589541b637484066d9cb51267ad7e03d3d7a9a1b459` |
| `liechtenstein-2015-v1-1a7e19879423fcaf` | 17 | `5478c9b8e61ae8a43faa0d3283ad3fdc47724565520925037aacdb4e4f8799ed` |

They include driving, bicycle, pedestrian and truck requests, restrictions,
one-way behavior, disconnected pairs and outside coverage. Existing native
reference files were used unchanged. Successful results are compared as complete
native JSON, without numerical tolerances or ignored differences. Expected native
errors are checked by code; outside-coverage requests use the SDK's documented
coverage error before entering native search.

`test/search-memory.js` ran four policies (defaults, zero reservations, cleanup
enabled, and independent 4,096/65,536 overrides), both datasets and both tile
transports in each engine:

| Browser | Native-reference comparisons | Result | Maximum WASM capacity |
| --- | ---: | --- | ---: |
| Chromium 153.0.8010.12 | 480 | Passed | 64 MiB |
| Firefox 155.0 | 480 | Passed | 64 MiB |
| WebKit 26.6 | 480 | Passed | 64 MiB |

Every policy retained decoded tiles: the repeated long route made zero loader
requests. Each engine also passed invalid-initialization recovery, cancellation
during a real tile fetch followed by a successful route, persistence of custom
settings across worker replacement, and effective-configuration hash checks.
Archive GETs returned partial `206` responses with Range headers; no whole-archive
GET was consumed. The zero-reservation cases exercise actual vector growth rather
than silently treating a low reservation as a search cutoff.

Additional checks passed: all 36 unit tests, the existing Chromium browser suite
(31 checks including initialization, transport faults, serialization and CPU/fetch
cancellation), SDK typechecking/build/packing, the installed Chromium package in
development and production with both transports, all seven README examples, and
the TypeDoc build with documentation warnings treated as errors. The runtime
artifact hash was rechecked and remained unchanged.

## Before/after timing

The public-API benchmark used unchanged WASM, graph and native reference, the
indexed-TAR transport, a 32 MiB decoded-tile budget, and default retries/timeouts.
Only `searchMemory` changed. Legacy is `{ astar: 2000000,
bidirectionalAstar: 1000000, clearReservedMemory: false }`; current is the SDK
default. The route is Balzers–Ruggell in the regional corpus.

Device: Apple M2, 16 GiB RAM, macOS 26.7 arm64; Node 22.22.2, pnpm 12.4.2,
Playwright 1.63.0, Chromium 153.0.8010.12. Five cold samples use separate browser
contexts and workers per profile/policy; twenty warm samples reuse the final
worker. WASM compilation-cache state is uncontrolled. Delivery is loopback HTTP;
there is no CDN or R2 timing. The worker's `routeMs` excludes startup but includes
tile wait and Asyncify overhead. It is not a CPU-time measurement.

| Policy | Profile | Cold median / p95 (ms) | Warm median / p95 (ms) | Capacity peak (MiB) |
| --- | --- | ---: | ---: | ---: |
| Legacy | Driving | 382.5 / 415.5 | 15.3 / 21.6 | 165.5625 |
| Current | Driving | 394.0 / 406.9 | 15.2 / 22.9 | 64 |
| Legacy | Bicycle | 412.6 / 435.0 | 21.5 / 27.9 | 165.5625 |
| Current | Bicycle | 384.0 / 387.0 | 21.0 / 26.1 | 64 |
| Legacy | Pedestrian | 383.4 / 411.0 | 18.2 / 22.4 | 165.625 |
| Current | Pedestrian | 383.6 / 617.7 | 23.1 / 33.4 | 64 |
| Legacy | Truck | 401.5 / 448.4 | 18.8 / 26.9 | 165.5625 |
| Current | Truck | 384.2 / 394.1 | 15.9 / 22.6 | 64 |

Medians use the midpoint of the two central samples for even sample counts;
p95 uses nearest rank. The memory reduction is repeatable across the three engines. Timing is variable:
the current pedestrian run had a cold outlier and slower warm samples. An earlier
exploratory run had similar pedestrian medians (18.8 ms legacy, 18.5 ms with
16,384), so these short runs do not establish either a consistent slowdown or a
speed improvement. No latency budget or production performance claim is implied.

Across the profile/policy groups, median module startup was 59.6–65.8 ms, graph
startup 24.9–28.4 ms, and host-observed worker readiness 88.6–98.1 ms. Graph startup
recorded six requests and 13,502 bytes. Each cold route fetched five tiles in five
requests, totaling 1,476,944 bytes; median sequential tile wait was 9.4–10.4 ms.
Warm routes fetched no tiles. All regional tiles fit the decoded cache, which
retained 1,476,944 bytes. This demonstrates worker-memory reuse, not browser HTTP
cache persistence. HTTP transfer sizes and process RSS are not measured here.

## Reproduce

Prepare the existing runtime and both fixture datasets using the
[development guide](development.md) if absent, then run:

```sh
pnpm install --frozen-lockfile
pnpm run build:sdk
pnpm exec playwright install chromium firefox webkit
pnpm test
pnpm run test:search-memory
BROWSER=firefox pnpm run test:search-memory
BROWSER=webkit pnpm run test:search-memory
pnpm run benchmark:search-memory
```

Reports are written to `test-results/search-memory-<browser>.json` (ignored by
Git). They include identities, effective settings/hashes, per-case diagnostics,
startup timings and all cold/warm benchmark samples. The benchmark reruns the
integration checks and replaces that browser's report. CI runs the integration
checks for all three engines; timing comparisons remain an explicit local command.

The initial exploratory sweep and its raw results remain in the local ignored
`build/search-label-probe.mjs` and `build/search-label-probe.json`. The checked-in
benchmark reproduces the selected default versus legacy comparison without
intercepting or rewriting dataset metadata.

Build identity: Emscripten 6.0.0, Protobuf 21.12, zlib 1.3.1;
WASM size 10,046,298 bytes and SHA-256
`366f9b103751df4cb259cf51c35a6f6515cfb0e22da7f80ef9059749b0ec7444`.
The [runtime lock](../native/runtime-lock.json) and compiled artifact are unchanged.

## Remaining scope

64 MiB is the build's initial allocation, not a new limit. WASM may still grow to
its configured 512 MiB maximum, and JavaScript, tile buffers, output and loader
indexes consume additional memory. The current fixture region is small. Larger
graphs, long-distance routes, adverse searches and target devices must be measured
before choosing a stricter memory envelope or revising defaults again.

This reduction removes the observed small-corpus WASM memory obstacle to a
Cloudflare feasibility prototype. It does not make the browser package compatible
with Workers or prove an entire isolate fits its budget. A separate runtime
adapter, actual workerd routing, request-context I/O, safe scheduling/cancellation,
and edge resource measurements remain necessary; see the
[Workers assessment](cloudflare-workers-assessment.md).
