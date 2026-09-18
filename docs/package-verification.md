# TypeScript package verification — 2026-09-18

This report describes the pre-workspace run. For current commands and package
layout, see [development setup](development.md); new verification is recorded in
[workspace verification](workspace-verification.md).

The SDK is now an ESM-only TypeScript package with generated declarations,
an automatically located module worker, and the unchanged compiled WASM included.
The Vite demo uses the distribution. Native graph preparation, indexed TARs,
Asyncify, validators, and both tile transports retain their existing behavior.
This is a locally verified, unpublished `@tobilg/valhalla-browser@0.0.1` package.

## Build and delivery

- Node 22.22.2, npm 10.9.7, Vite 8.3.0, TypeScript 7.0.2, tsx 4.23.13,
  Playwright 1.58.2 and `@types/node` 22.20.3 are pinned. Vite 8.3.0 was the
  current stable npm release when selected.
- Valhalla 3.8.3, revision `a60c7cbfc83e073f50887cd27e0109d02e6b64e5`,
  Emscripten 6.0.0, Protobuf 21.12 and zlib 1.3.1 are unchanged. The existing
  source-built artifacts were reused and hash-verified; C++ compilation was
  not rerun for this packaging change. See [the runtime lock](../native/runtime-lock.json).
- `npm ci --offline --no-audit --no-fund`, strict main-thread and worker
  typechecking, package builds, and the Vite production demo build executed
  successfully on this workstation. A clean checkout still needs the explicit
  native/WASM commands in [development setup](development.md).
- The package contains JavaScript, declarations, sourcemaps, a single WASM,
  provenance and license texts. No graph, native checkout, test fixtures,
  credentials or install-time compiler is included. No runtime npm dependency
  or install hook is required.
- A same-origin module worker loads directly. Cross-origin ESM uses a static
  blob-module import with absolute worker/WASM URLs; its object URL is revoked.
  Explicit asset overrides support self-hosting under stricter CSP. Importing
  the main module starts no downloads and works without browser globals.
- Worker loading and WASM startup are bounded and recoverable. WASM startup
  receives at least ten seconds even with a shorter tile-fetch timeout.

The generated `dist/runtime.json` identifies the native input artifacts. The
standalone WASM is **10,046,298 bytes** with SHA-256
`366f9b103751df4cb259cf51c35a6f6515cfb0e22da7f80ef9059749b0ec7444`.
The tested distribution's main module is **6,257 bytes**, worker **119,837 bytes**,
and npm tarball **2,567,100 bytes** (**12,747,517 bytes** unpacked, including maps
and notices). These are artifact sizes, not measured CDN transfer sizes.
The installable file is `build/package/tobilg-valhalla-browser-0.0.1.tgz`.
The final prepack build reproduced the same main-module, worker and WASM hashes.

## Executed integration checks

| Command | Result and scope |
| --- | --- |
| `npm test` | 11 HTTP/loader tests passed. |
| `npm run test:package` | 12 cases: actual npm tarball installed in an isolated Vite application; dev and nested-base production builds; both transports; Chromium, Firefox and WebKit. Strict consumer typechecks, import without browser globals, lazy assets, native route equality, warm reuse, cancellation and native-equivalent recovery passed. |
| `npm run test:cdn-import` | Three distinct origins for unpacked SDK, application and graph. 12 cold/warm cases, 72 native corpus comparisons and 27 asset/failure/recovery checks passed across all three engines. |
| `npm run test:browser`, repeated with `BROWSER=firefox` and `BROWSER=webkit` | 18 existing native/WASM integration checks per engine, 54 total, passed through the packaged worker. |
| `npm run test:matrix` | 72 native comparisons over actual MinIO and 30 regional comparisons over local HTTP; 25 checks passed. Five cold and twenty warm regional samples per transport/engine, cancellation/recovery, origin-byte verification and browser HTTP-cache experiments executed. |
| `npm run test:demo -- --minio` and `npm run test:demo -- --preview --minio` | Development and built production Vite demos passed six UI checks each: route geometry, cancellation, recovery, regional graph selection/rendering and same-worker cache reuse. |

The CDN-import suite covers missing worker/WASM, worker/WASM CORS failure,
worker and WASM startup timeouts, bootstrap cancellation/revocation, concurrent
route submissions, cancellation during a suspended fetch, subsequent native
route equality, CSP refusal and same-origin asset overrides. Independent fault
scenarios use isolated browser contexts; recovery within a scenario uses the
same Router. It serves **only unpacked package files**, not repository sources.
The test uses uncompressed, `no-store` SDK responses. Public jsDelivr/UNPKG
delivery has not been tested because this package has not been published.

Native/browser comparisons use complete native JSON equality, with no numerical
tolerance or geometry substitution. The seven synthetic and five regional cases
include cross-tile routes, restrictions/one-way behavior, disconnected and
outside-coverage requests. The existing suite also proves local-tile M1, real
Asyncify initialization and routing suspension, range/integrity failures,
transient download recovery, bounded decoded caching, and termination during
uninterrupted native CPU work. The archive body is never fetched in full.

This document summarizes the executed run. Raw reports and screenshots are no
longer committed. The commands above generate fresh output in ignored
`test-results/`, including `package.json`, `cdn-import.json`, `browser.json`,
`browser-firefox.json`, `browser-webkit.json`, `matrix.json`, and `demo*.json/png`.
Fresh measurements can differ from this historical baseline.

The MinIO run recorded 239 completed archive
GETs, each an exact selective 206, and two cancelled GETs. Both cancellations
recorded a 458-byte `application/xml` error response with status 499, not graph
data. No archive-sized response was transferred.

## Local cross-origin baseline

Workstation: macOS arm64, Apple M2, 16 GiB RAM. Browsers: Chromium
145.0.7632.6, Firefox 146.0.1 and Playwright WebKit 26.0. These are desktop
engines; WebKit testing is not a physical iPhone Safari result.

The following are **one cold and one same-worker warm sample per row** from
the CDN-import proof, not latency percentiles. The route is Balzers–Ruggell
using `liechtenstein-2015-v1-101d55d9c93febce`, configuration SHA-256
`5478c9b8e61ae8a43faa0d3283ad3fdc47724565520925037aacdb4e4f8799ed`.
Each row starts a fresh worker/browser context. Graph delivery is loopback HTTP,
with no CDN. WASM compilation cache and background workstation load are not
controlled. Ready time includes startup; route time starts after initialization.

| Engine | Transport | Worker ready ms | Module ms | Graph startup ms | Cold route ms | Warm route ms | Cold sequential tile wait ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | Indexed TAR | 114.4 | 67.8 | 41.0 | 528.2 | 47.5 | 37.2 |
| Chromium | Individual | 94.2 | 63.9 | 25.1 | 565.9 | 37.1 | 46.4 |
| Firefox | Indexed TAR | 336.0 | 285.0 | 37.0 | 1003.0 | 58.0 | 15.0 |
| Firefox | Individual | 283.0 | 260.0 | 11.0 | 1019.0 | 61.0 | 21.0 |
| WebKit | Indexed TAR | 94.0 | 59.0 | 27.0 | 1038.0 | 81.0 | 26.0 |
| WebKit | Individual | 78.0 | 50.0 | 20.0 | 1067.0 | 100.0 | 37.0 |

Each cold regional route downloaded five complete tiles in five requests:
**1,476,944 validated tile bytes**, separate from startup metadata. Each warm
route made **zero tile requests** and recorded decoded-cache hits. The full
archive is 1,484,800 bytes; this small graph's long route needs most of its tiles,
but they arrive through selective range requests. Recorded WASM linear-memory
capacity peaked at **173,670,400 bytes**; this is neither live allocation nor
process RSS. The decoded-cache budget remains 32 MiB.

Browser HTTP-cache experiments and CDN cache status are separate from this
same-worker reuse proof. Historical public R2 measurements remain in
[the CDN report](cdn-benchmarks.md). No new public CDN performance
or transfer-size claim is inferred from local package tests.

The sequential MinIO run measured the same route against the digest-pinned
loopback S3 service, without a proxy or CDN. Cold samples used new browser contexts
and workers, with actual origin requests verified; warm samples reused one worker.
Cold time below includes worker initialization and routing. With five cold
samples, p95 is the largest observed value, not a stable population estimate.

| Engine | Transport | Cold p50 / p95 ms (n=5) | Warm p50 / p95 ms (n=20) |
| --- | --- | ---: | ---: |
| Chromium | Indexed TAR | 541.7 / 566.5 | 16.5 / 27.3 |
| Chromium | Individual | 529.5 / 535.3 | 16.4 / 20.3 |
| Firefox | Indexed TAR | 1496 / 1643 | 65 / 74 |
| Firefox | Individual | 1722 / 2001 | 73 / 85 |
| WebKit | Indexed TAR | 1392 / 1496 | 70 / 84 |
| WebKit | Individual | 1436 / 1821 | 71 / 86 |

MinIO origin traces confirm identical-range reuse in Chromium/WebKit, including
reload, page reopen and browser-process restart. Firefox refetched ranges in
those states. All engines fetched the overlapping range and reused individual
objects after their first fetch. MinIO supplies no Timing-Allow-Origin, so browser
transfer sizes are unknown; origin traces, not Resource Timing zeros, establish
these cache observations.

Proposed, **unapproved** package-size regression budgets based on this baseline:
8 KiB main ESM, 160 KiB worker, 11 MiB standalone WASM and 3 MiB compressed npm
tarball. Existing measured runtime budgets remain provisional. This small sample
does not establish new latency targets or release readiness.

## Cleanup and limits

Superseded JavaScript SDK sources and handwritten declarations were replaced
with TypeScript. The old demo-serving path was replaced by Vite; the reusable
HTTP range handler and native tools remain. R2 upload instructions now use one
canonical manifest path, and obsolete manifest-alias generation was removed.
The ignored root alias was preserved under `build/legacy-datasets/manifest-aliases/`.
Raw reports and screenshots are no longer tracked; the native, CDN baseline and
unresolved-cache summaries remain in Markdown. Generated SDK artifacts, tarballs,
test reports and demo output remain ignored. Dataset bytes and the supplied
upstream checkout were preserved.

During verification, reused fault-test pages and overlapping browser runs
produced timeouts/stalled WebKit startup. Fault scenarios now have independent
contexts, startup has a bounded recovery path, and the final full suites passed.
No browser-vendor root cause is established. A MinIO cancellation trace also
recorded 458 response bytes on status 499; zero bytes was an invalid test
assumption. Trace verification now checks valid selective requests for all
archive GETs, exact range/length for completed 206 responses, and no full archive
body including aborted requests. The loader never accepts 499 as tile data.

The CI workflow was updated but not executed remotely. No package was published,
no R2 objects/rules were changed, and no upstream submission was made. Physical
devices, other bundlers and public package CDN behavior remain unverified.
The local MinIO container started for this run was stopped afterward; its volume
was preserved. Restart it with `npm run minio:start` for MinIO-specific demo tests.
The next release step is an authorized npm publication followed by an actual
version-pinned public-CDN smoke test and the manual clean-build CI run. Scope
beyond packaging remains in [implementation status](implementation-status.md).
