# Regional MinIO and browser measurements

This report describes the pre-workspace run. For current commands and package
layout, see [development setup](development.md); new verification is recorded in
[workspace verification](workspace-verification.md).

Executed September 17, 2026, on Apple M2 / arm64 macOS, 16 GiB host RAM,
Node 22.22.2 and Playwright 1.58.2. The final run started at
`2026-09-17T15:19:06.129Z`; builds and other browser suites had finished.
MinIO runs in Docker Desktop on the same host, with direct cross-origin
loopback fetches and no CDN. The [reproduction commands](minio.md) generate
`test-results/matrix.json`; raw reports are not committed.

The graph is Liechtenstein 2015, release
`liechtenstein-2015-v1-101d55d9c93febce`, Valhalla 3.8.3 at
`a60c7cbfc83e073f50887cd27e0109d02e6b64e5`, Emscripten 6.0.0. The route is
Balzers–Ruggell, 21.838 km. Entire native JSON matches exactly on all browsers
and both transports. The retained tile-cache budget is 32 MiB.

## Route and startup baseline

Cold samples each use an empty worker and a new isolated browser context;
actual MinIO origin requests are recorded. WASM compilation caches are not
controlled. Cold latency includes worker initialization and the route; warm
latency is a subsequent request in the same initialized worker. There are
**five cold and twenty warm samples per browser/transport**; p95 with five
samples is the maximum, so these are provisional development measurements.

| Browser | Transport | Cold p50 / p95 ms | Warm p50 / p95 ms |
| --- | --- | --- | --- |
| Chromium 145.0.7632.6 | Archive | 540.0 / 547.9 | 16.8 / 26.6 |
| Chromium 145.0.7632.6 | Individual | 524.7 / 530.0 | 16.2 / 21.5 |
| Firefox 146.0.1 | Archive | 1486 / 1781 | 61 / 84 |
| Firefox 146.0.1 | Individual | 1494 / 1521 | 62 / 69 |
| WebKit 26.0 | Archive | 1168 / 1384 | 71 / 85 |
| WebKit 26.0 | Individual | 1166 / 1191 | 71 / 83 |

| Browser / transport | Module startup p50 ms | Graph startup p50 ms | Route sequential wait p50 ms |
| --- | --- | --- | --- |
| Chromium archive | 68.4 | 37.1 | 38.0 |
| Chromium individual | 69.4 | 23.9 | 34.5 |
| Firefox archive | 341 | 57 | 71 |
| Firefox individual | 293 | 22 | 63 |
| WebKit archive | 59 | 44 | 50 |
| WebKit individual | 64 | 23 | 51 |

Archive initialization makes six Fetch attempts including manifest/config,
with 13,814 validated bytes. Four attempts are native header/index reads,
totalling 1,184 bytes: the pinned upstream `CURL_OR_THROW` macro evaluates
successful getter expressions twice. Individual initialization makes two
metadata requests / 12,630 bytes. This behavior remains visible in counters.

Each cold long route fetches five tiles / **1,476,944 bytes** through either
transport. Every warm request makes **zero** tile/loader requests, with decoded
cache hits. The short urban case fetches four tiles / 1,458,880 bytes; such
coarse real tiles demonstrate why route length alone does not predict transfer
volume. The long route uses all tiles in this small regional graph. The
synthetic fixture separately confirms six-of-seven-tile selective loading.

Including metadata, a cold archive session produced nine origin GETs /
1,490,166 body bytes in Chromium and eleven / 1,490,758 in Firefox/WebKit.
Individual sessions produced seven / 1,489,574. These are server body bytes,
not HTTP headers, TCP/TLS traffic or CDN bytes. MinIO traced 240 completed
archive GETs, all selective `206`, plus one cancelled `499` request with zero
body bytes. No `200` archive GET or whole-archive body was accepted.

WASM linear-memory capacity grew from 64 MiB to **173,670,400 bytes** in
Chromium/Firefox and **173,604,864 bytes** in WebKit (about 165.6 MiB).
Retained decoded tiles were 1,476,944 bytes. Capacity includes reserved/search
memory and is not live malloc usage; process RSS and physical handset memory
were not measured. The runtime artifact is unchanged: 10,046,298 bytes WASM
and 171,143 bytes JS, uncompressed, as recorded in
[the runtime lock](../native/runtime-lock.json).

## HTTP caching

Each browser used its own fresh **persistent** profile for this experiment.
After identical/overlapping fetches, the test reloaded, closed/reopened the
page, then shut down and relaunched the entire browser process with that
profile. One sequence per engine; no quota or eviction-pressure experiment.

| Probe after first fetch | Chromium origin bytes | Firefox origin bytes | WebKit origin bytes |
| --- | --- | --- | --- |
| Identical `0–511` range | 0 | 512 | 0 |
| Overlapping `256–767` range | 256 | 512 | 512 |
| Range after reload | 0 | 512 | 0 |
| Range after page reopen | 0 | 512 | 0 |
| Range after browser process restart | 0 | 512 | 0 |
| Identical individual object | 0 | 0 | 0 |
| Individual after reload/page reopen/process restart | 0 | 0 | 0 |

The first range transferred 512 bytes and the first individual object 62,664
bytes on each browser. Zeros in this table mean **no matching request in the
active MinIO origin trace**, not a guess based on browser timing fields.
MinIO lacks Timing-Allow-Origin here; cross-origin browser transfer/cache
measurements remain `null`/unknown. WebKit's isolated benchmark contexts and
persistent-profile cache experiment show different duplicate-initialization
reuse; these are separate cache configurations, not interchangeable claims.

Firefox range reuse was ineffective in this tested configuration, while
individual objects reused the HTTP cache. That supports evaluating the
existing individual transport for Firefox session reuse. It does not justify
mandatory OPFS or prove offline completeness. No browser-specific transport
switching or speculative prefetch is enabled.

## Verification and remaining measurements

- 72 MinIO native-corpus comparisons (12 cases × two transports × three engines),
  plus the 30 regional local-HTTP comparisons.
- 18 integration/fault tests per engine: local-WASM proof, serialized suspended
  actor calls, invalid/missing/corrupt responses, initialization recovery,
  eviction, network cancellation, uninterrupted real-actor CPU cancellation,
  and successful subsequent routes.
- MinIO cancellation/recovery per engine, native-equivalent routes under
  Pixel 7 and iPhone 13 viewport/touch emulation, and actual demo interaction.
- Nine HTTP loader tests; real native graph/admin/timezone build; archive,
  manifest and native-reference byte reproducibility.

Emulation uses this desktop CPU/RAM and Playwright engines. WebKit is not an
actual iPhone Safari run. Physical mobile devices, WAN/latency shaping, larger
regions, memory pressure, full-browser-process RSS, and an actual CDN are
outstanding. The manually triggered CI workflow is authored but has not run.

`benchmarks/regional-provisional-budgets.json` proposes numerical desktop
budgets after this baseline: 2,000 ms cold p95, 100 ms warm p95, 192 MiB WASM
capacity, and the measured tile-count/byte invariants. These are engineering
proposals, **not agreed release targets**. No M5 release-readiness claim is made.
