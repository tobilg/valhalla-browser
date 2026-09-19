# Road profile verification — 2026-09-19

This workspace adds `bicycle`, `pedestrian`, and `truck` alongside default `auto`,
with typed native settings and dataset capability checks. It has not been
published or deployed. Transit and bike-and-train remain deferred.

## Reproducible data and build

- Valhalla 3.8.3, revision `a60c7cbfc83e073f50887cd27e0109d02e6b64e5`;
  Emscripten 6.0.0, Protobuf 21.12, zlib 1.3.1. Native and WASM builds ran using
  the existing pinned container. No additional upstream patch was needed.
- The rebuilt WASM remains 10,046,298 bytes, SHA-256
  `366f9b103751df4cb259cf51c35a6f6515cfb0e22da7f80ef9059749b0ec7444`.
- Node 22.22.2, pnpm 12.4.2, Vite 8.3.0, TypeScript 7.0.2, Playwright 1.58.2.
  This workstation's global pnpm shim failed with ENOEXEC; verification used the
  pinned pnpm installed via `npx --yes --package=pnpm@12.4.2 pnpm` on PATH.
- Synthetic release `fixture-v1-d087a2c15b9dc394`: 43 reference requests,
  seven tiles, 40,960-byte indexed TAR.
- Regional release `liechtenstein-2015-v1-1a7e19879423fcaf`: 17 reference requests,
  five tiles, 1,484,800-byte indexed TAR; runtime configuration SHA-256
  `5478c9b8e61ae8a43faa0d3283ad3fdc47724565520925037aacdb4e4f8799ed`.
- Repeated native builds reproduced both releases. The regional graph/archive
  bytes are unchanged; its new identity includes the advertised profiles.
  Existing immutable releases were preserved. All twelve previous driving
  reference responses remain exactly unchanged.

Native Balzers–Ruggell results on the July 2015 regional graph:

| Profile | Length (km) | Estimated journey time (seconds) |
| --- | ---: | ---: |
| Driving | 21.838 | 1327.858 |
| Cycling | 22.089 | 4515.944 |
| Walking | 21.352 | 15084.235 |
| Truck | 23.750 | 2509.333 |

Journey times above are native route estimates, not computation measurements.

## Checks executed

- 31 unit tests and seven native archive/data tests passed.
- 29 browser integration checks per engine passed: Chromium 145.0.7632.6,
  Firefox 146.0.1, WebKit 26.0 on macOS arm64, Apple M2, 16 GiB RAM.
  Each engine compared the complete 43-case synthetic corpus over both transports.
- The fresh OSM-to-archive workflow passed both transports against new native
  regional references. Full JSON equality was required; no tolerance or route
  substitution was introduced.
- Synthetic requests prove bicycle-only and walking-only shortcuts, bicycle
  contraflow, truck height/width/length/weight/axle-load/hazmat detours, and speed
  options. Mixed concurrent profiles retain native equivalence and warm cache reuse.
- Capability tests cover legacy auto-only datasets, bicycle-only datasets, future
  advertised profiles, unsupported-profile rejection and subsequent successful routing.
- Cancellation during cycling tile loading followed by walking succeeds.
  Existing network, startup recovery and CPU cancellation checks also pass.
- The enlarged fixture exposed an upstream hard-LRU exception for a tile larger
  than the cache budget. Initialization now rejects that configuration explicitly
  with `INVALID_REQUEST`. At an 11,432-byte budget, the eviction test reloads tiles
  and still matches native output while retained cache bytes remain bounded.
- Packed-package consumption passed 12 browser/mode/transport combinations,
  including the new profiles and TypeScript rejection of mismatched settings.
  Cross-origin CDN imports passed both complete corpora and lifecycle/CSP checks.
- All seven README examples typechecked and executed. Demo development/preview
  passed against MinIO. Static demo tests passed 13 checks per browser, including
  every profile, configured walking speed, settings reset, custom coordinates,
  disabled controls, cancellation, old-dataset rejection and subsequent driving.
- TypeDoc built without warnings; source-only docs, internal links, search,
  README homepage and the new guide navigation passed all three engines.
- The demo built with the repository's configured manifest URL passed artifact
  startup checks in all three engines. This did not deploy or benchmark that CDN.
- The complete MinIO matrix passed 360 native-equivalence cases, 25 checks,
  24 benchmark groups and 33 browser-cache observations. The origin trace showed
  615 completed selective archive GETs, all `206`, plus one cancelled request.
  No full archive body was downloaded.

Reports are generated under `test-results/` and `build/reports/`, and the existing
main/release workflow runs these expanded suites and preserves its report artifact.

## MinIO measurements

Run started at `2026-09-19T14:01:12.478Z`, using the browser/device versions above,
the regional Balzers–Ruggell journey and the default 32 MiB decoded-tile budget.
Delivery was directly from cross-origin MinIO on loopback, without a CDN.
Each profile/transport/engine group has five cold samples (new worker and isolated
browser context) and twenty warm samples (same worker and repeated route).
WASM compilation-cache state was not controlled. Cold time includes worker/module
and graph initialization plus routing; warm time is the host-observed route call.

Times below are **median (p95), milliseconds**. With five cold samples, p95 is
the largest sample and should not be treated as a stable population percentile.

| Browser | Profile | Archive cold | Archive warm | Individual cold | Individual warm |
| --- | --- | ---: | ---: | ---: | ---: |
| Chromium | Driving | 543.4 (552.7) | 16.0 (22.2) | 525.6 (554.3) | 15.7 (19.8) |
| Chromium | Cycling | 535.7 (561.8) | 21.8 (24.8) | 521.6 (555.2) | 21.3 (25.0) |
| Chromium | Walking | 534.3 (540.1) | 18.7 (22.8) | 523.1 (566.0) | 18.9 (25.1) |
| Chromium | Truck | 527.0 (532.7) | 16.4 (21.0) | 510.0 (533.0) | 17.0 (22.5) |
| Firefox | Driving | 1253 (1294) | 55 (57) | 1220 (1238) | 54 (56) |
| Firefox | Cycling | 1297 (1325) | 72 (75) | 1238 (1251) | 72 (77) |
| Firefox | Walking | 1252 (1295) | 63 (66) | 1231 (1237) | 63 (68) |
| Firefox | Truck | 1255 (1269) | 56 (60) | 1220 (1257) | 57 (67) |
| WebKit | Driving | 1091 (1100) | 60 (79) | 1078 (1093) | 65 (77) |
| WebKit | Cycling | 1112 (1140) | 77 (95) | 1130 (1139) | 80 (95) |
| WebKit | Walking | 1136 (1141) | 71 (88) | 1111 (1117) | 72 (82) |
| WebKit | Truck | 1109 (1167) | 59 (81) | 1086 (1109) | 65 (77) |

Ranges of the four profile medians, in milliseconds:

| Browser | Transport | Module startup | Graph startup | Cold worker route | Sequential tile wait |
| --- | --- | ---: | ---: | ---: | ---: |
| Chromium | Archive | 68.8–71.3 | 37.3–38.2 | 413.2–424.3 | 37.5–38.3 |
| Chromium | Individual | 69.4–71.8 | 25.3–26.2 | 405.4–419.4 | 32.9–38.0 |
| Firefox | Archive | 247–262 | 33–37 | 947–977 | 34–35 |
| Firefox | Individual | 245–253 | 15–16 | 946–957 | 31–34 |
| WebKit | Archive | 53–57 | 40–42 | 977–1030 | 43–62 |
| WebKit | Individual | 53–60 | 22–24 | 994–1044 | 39–60 |

Worker route time includes suspended network waits. Graph startup includes metadata
validation. Archive startup consumed 13,860 metadata bytes across six loader-level
requests, versus 12,676 bytes across two requests for individual tiles; browser
HTTP caching can reduce the number reaching the origin.

Every cold benchmark route downloaded five complete tiles totaling 1,476,944 bytes
in five tile requests. This small journey reaches all five tiles in the regional
dataset; selective fetching does not imply it always avoids most graph bytes.
All **480 warm samples made zero loader requests**, retained 1,476,944 decoded-cache
bytes, and recorded native cache hits. Maximum allocated WASM linear-memory capacity
was 165.625 MiB for the benchmark, and 314.0625 MiB across the broader fixture corpus.
These are capacity high-water marks, not live allocation or process RSS; the
decoded-tile budget does not bound all routing working memory.

MinIO origin tracing, rather than cross-origin Resource Timing, established cache
reuse. Browser transfer sizes are unavailable because this MinIO setup does not
provide `Timing-Allow-Origin`; Resource Timing zeros are not reported as zero-byte
network transfers. There was no CDN cache to measure.

| Observed HTTP-cache behavior | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Identical 512-byte range | No origin request | Fetched 512 bytes again | No origin request |
| Half-overlapping 512-byte range | Fetched missing 256 bytes | Fetched 512 bytes | Fetched 512 bytes |
| Original range after reload, page reopen, browser restart | No origin requests | Fetched 512 bytes each time | No origin requests |
| Same individual tile, including reload/reopen/restart | No origin requests | No origin requests | No origin requests |

These observations apply to the tested versions and headers; persistent `206`
caching remains browser-dependent. No offline storage or prefetch was added.
Provisional investigation thresholds for a repeat on this desktop/loopback setup
are cold p95 below 1.5 seconds, warm p95 below 120 ms, zero warm tile requests,
and benchmark heap capacity below 200 MiB. These are proposed regression budgets,
not agreed release targets or expectations for mobile devices, larger graphs or CDN delivery.

## Reproduction

After the workspace setup in [development](development.md):

```sh
pnpm run build:native
pnpm run data
pnpm run data:region
pnpm run build:wasm
pnpm run build
pnpm test
pnpm run test:data
pnpm run test:data:build
pnpm run test:browser
BROWSER=firefox pnpm run test:browser
BROWSER=webkit pnpm run test:browser
pnpm run pack:sdk
pnpm run test:package
pnpm run test:cdn-import
pnpm run test:examples
pnpm run minio:start
pnpm run minio:publish
pnpm run test:demo --minio
pnpm run test:demo --preview --minio
pnpm run test:demo:static
pnpm run test:docs
pnpm run test:matrix
pnpm run minio:stop
pnpm run r2:prepare
```

The prepared regional upload contains eight objects under
`build/r2-upload/datasets/liechtenstein-2015-v1-1a7e19879423fcaf/`.
Upload to that matching remote release prefix and verify delivery ETags as described
in [object storage hosting](object-storage-hosting.md), then update the demo's
manifest environment variable and rebuild. Publishing a new SDK version and
deploying the sites are separate actions. Existing auto-only deployments keep
working for driving.
