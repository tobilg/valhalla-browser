# Development baseline

This report describes the pre-workspace run. For current commands and package
layout, see [development setup](development.md); new verification is recorded in
[workspace verification](workspace-verification.md).

This preserves the original synthetic/Chromium baseline. The later real-graph,
MinIO and three-engine results are in [regional measurements](regional-benchmarks.md).
Limitations below describe the original run, not the current implementation.

Executed **2026-09-17**, Apple M2, 16 GiB RAM, macOS/arm64, Chromium **145.0.7632.6** through Playwright **1.58.2**, Node **22.22.2**. Native reference: Linux/arm64 container, GCC 13.3, Valhalla 3.8.3. Source/toolchain locks and artifact hashes are in [the runtime lock](../native/runtime-lock.json). Raw reports are not committed; `npm run benchmark` writes fresh observations to `test-results/browser.json`.

Commands actually run: native/WASM builds through `scripts/build-container.sh`, `npm run data`, `npm test`, `npm run test:browser`, `npm run test:demo`, and `npm run benchmark`. A second graph build reproduced identical archive, manifest, and reference hashes. Nine loader/HTTP tests and **19 browser checks** passed. The demo also passed its separate click/cancel/recovery test and was visually inspected.

## Route timings

Same 5.609 km driving fixture, exact native geometry/summary/maneuver JSON, no tolerance needed. `hostRouteMs` measures host API invocation to usable result, including worker messaging. Initialization precedes these samples. Percentiles use nearest rank; ten cold samples are exploratory, not a stable tail-latency guarantee.

| Transport | Worker / HTTP state | n | p50 | p95 |
| --- | --- | ---: | ---: | ---: |
| Native indexed TAR | Empty worker, HTTP cache cleared | 10 | 432.8 ms | 554.3 ms |
| Individual tiles | Empty worker, HTTP cache cleared | 10 | 409.7 ms | 507.3 ms |
| Native indexed TAR | Same worker after one warm-up route | 20 | 2.3 ms | 3.9 ms |
| Individual tiles | Same worker after one warm-up route | 20 | 3.2 ms | 5.6 ms |

Browser compilation-cache state was **not** cleared. These are cold worker/HTTP measurements, not fully cold browser-process measurements. No CDN was used. The archive/individual difference is too small and noisy on this fixture to select a production transport from latency alone.

| Initialization metric | Archive p50 / p95 | Individual p50 / p95 |
| --- | ---: | ---: |
| Module creation (WASM load/compile/init) | 80.3 / 92.9 ms | 79.5 / 90.8 ms |
| Graph metadata + native actor initialization | 35.9 / 98.3 ms | 23.2 / 28.9 ms |
| Host initialization to worker ready, including JS worker loading | 129.3 / 204.1 ms | 111.5 / 131.9 ms |

Static JS module import precedes the module-creation timer; the host worker-ready timer includes it. Artifact sizes: **10,046,298 bytes WASM**, **171,143 bytes JS**, uncompressed. These are file sizes, not an assertion about every browser transfer. Public WASM files currently revalidate; production compression/module packaging has not been optimized.

## Graph, waits, and memory

The native TAR has **7 tiles**, **30,720 bytes**, a **512-byte header**, and **112-byte native index**. The cross-tile route downloads **6 complete tiles**, totaling **16,840 payload bytes**, including hierarchy levels 0 and 1 and four local tiles. The distant seventh tile is unused. Every normal archive response is a partial `206`; no whole-archive response is consumed. Server records corroborate the requested offsets and lengths.

Archive initialization makes four native Fetch attempts: this revision's `CURL_OR_THROW` macro evaluates each successful header/index expression twice. That is **1,248 validated header/index bytes**. Including the manifest and effective configuration, graph startup totals **6 Fetch attempts / 13,037 validated bytes**. Individual-object startup uses **2 attempts / 11,789 bytes** for manifest/config. Validated bytes are bytes delivered to the loader, not necessarily origin transfer bytes when HTTP caching applies.

Generated browser reports include per-route accumulated sequential wait, exact ranges, Fetch attempt count, and actual origin request records. Every warm default-cache route has zero tile downloads and positive decoded-cache hits. Fetch attempt counts can differ from origin request counts because Chromium may cache, combine ranges, or internally replay requests after connection/validator failures.

Default retained tile-cache budget: **32 MiB**. The cold cross-tile route retains **16,840 bytes** in that cache. WASM linear-memory capacity starts at **64 MiB** and reaches **171,966,464 bytes (164 MiB)**. This reflects routing/search allocation as well as tiles; no claim is made that the whole worker fits the tile budget. The hard maximum linear-memory setting is 512 MiB. JavaScript/browser process RSS and peak live malloc usage were not measured.

The 5,000-byte-cache test forces eviction and repeated downloads; both routes remain exactly native-equivalent, retained cache bytes stay within the budget, and live tile references remain valid. Native per-case traces are generated in `build/reports/native.jsonl`. The original run recorded one sequential sample each: short first route 58.4 ms, cross-tile second route 2.24 ms. Those native samples are not comparable cold p95 measurements.

## HTTP cache observations

Worker memory and HTTP cache were tested independently. A fresh browser context's HTTP cache was explicitly cleared before the following direct HTTP experiment; it did not reuse decoded Valhalla tiles.

| Request | Actual origin work | Browser observation |
| --- | --- | --- |
| First `bytes=0-511` | One 512-byte response | 206, 812 Resource Timing transfer bytes |
| Same range again | None | 206, transfer size 0 |
| Overlap `bytes=256-767` | One request for missing `bytes=512-767`, 256 bytes | 512-byte result assembled; transfer size 556 |
| First individual tile | One 1,488-byte response | 200, transfer size 1,788 |
| Same individual tile again | None | 200, transfer size 0 |
| Range and individual tile after reload | None | Cached results |
| Range and individual tile after page close/reopen in same context | None | Cached results |

The zero transfer sizes here are supported by same-origin Resource Timing **and** absence of corresponding origin requests. Unrelated discovery revalidation is separately recorded as background requests. Browser close/restart, eviction pressure, Firefox, WebKit, mobile devices, and actual S3/CDN delivery were not tested. These results establish observed Chromium behavior, not offline guarantees or universal `206` caching support.

## Failures and cancellation

Actual browser tests exercise ignored Range, wrong Content-Range, changed strong validator, HTTP 503, truncated bodies, dropped connections, corrupt tiles, missing expected objects, initialization failure, concurrent host submissions during real suspension, and cache eviction. Subsequent routes succeed on the same actor after recoverable transport errors. No failure is accepted as a false no-route.

Termination-based cancellation passed during a delayed tile fetch, during route-triggered asynchronous initialization, and during uninterrupted real native actor CPU work. The measured host cancellation-to-rejection samples were **4.23 ms** during fetch and **3.14 ms** during the CPU test. These are one sample each. Cancellation rejects all outstanding work, discards that worker, and the next route recreates it successfully. A new-worker identity check suppresses stale messages.

## Provisional budgets and next experiment

`benchmarks/provisional-budgets.json` proposes fixture-only p95 budgets of **300 ms worker readiness**, **750 ms cold route**, **10 ms warm route**, **192 MiB WASM capacity**, and **50 ms cancellation acknowledgement**. The file also records the measured tile byte/request invariants. These are engineering proposals after measurement, **not owner-approved release criteria**. Mobile/process-memory/CDN budgets remain unknown.

The next useful experiment is a coherent real regional graph with admin/timezone inputs across desktop/mobile browsers and a verified S3/CDN path. The tiny graph cannot establish long-route performance, index scaling, memory behavior on large searches, provider range caching, or bike/transit feasibility. Keep demand-only loading until that evidence identifies a bottleneck.
