# pnpm workspace verification — 2026-09-18

The renamed `valhalla-browser@0.0.1` tarball, separate Vite demo, and TypeDoc
documentation passed local verification. The package includes the existing
compiled WASM. Native sources, graph bytes and runtime pins were unchanged;
this migration did not rerun the native compilation or graph preparation.

## Environment and artifacts

Executed on macOS/arm64, Apple M2, 16 GiB RAM, Node 22.22.2, pnpm 12.4.2,
Playwright 1.58.2. Browser versions were Chromium 145.0.7632.6, Firefox 146.0.1
and WebKit 26.0. SDK/demo use Vite 8.3.0 and SDK TypeScript 7.0.2. Documentation
uses TypeDoc 0.28.20 with TypeScript 6.0.3 and Wrangler 4.134.0.

The native pins remain Valhalla 3.8.3 at
`a60c7cbfc83e073f50887cd27e0109d02e6b64e5`, Emscripten 6.0.0,
Protobuf 21.12 and zlib 1.3.1. Packaging verifies [the runtime lock](../native/runtime-lock.json).

| Artifact | Result |
| --- | --- |
| `build/package/valhalla-browser-0.0.1.tgz` | 2,610,044 bytes; 12,754,619 unpacked bytes across 30 files |
| Tarball SHA-256 | `788ec37510b96b7b79632696494d325a127da371cd09a676e0ff4db5efe6958c` |
| Included WASM | 10,046,298 bytes; unchanged SHA-256 `366f9b103751df4cb259cf51c35a6f6515cfb0e22da7f80ef9059749b0ec7444` |
| Repeated packing | A second pack of the same build output was byte-identical |
| Documentation | 30 HTML pages, 273 internal links/anchors checked; root README is the homepage |

The SDK contains declarations, ESM, worker, WASM, runtime provenance, README and
licenses. It contains no graphs, credentials, demo, documentation site, consumer
install hooks or runtime npm dependencies. Both workspace applications are private.

## Commands and checks executed

The previously installed global pnpm 10.33.3 failed its version-12 handoff with
ENOEXEC on this Mac. Tests used pnpm 12.4.2 directly through this cached launcher:

```sh
npm exec --offline --yes --cache /private/tmp/valhalla-pnpm-plan-cache --package=pnpm@12.4.2 -- pnpm --version
```

Commands below used that launcher in place of `pnpm`. On a machine with pnpm
12.4.2 installed directly, run them as written. The first dependency installation
used network access; a fresh frozen installation then passed from the local store.
The old npm node_modules was preserved under ignored `build/pre-workspace-node_modules`.

```sh
pnpm install --frozen-lockfile --offline
pnpm run build
pnpm test
pnpm run pack:sdk
node scripts/release.js validate v0.0.1
node scripts/release.js candidate
node scripts/release.js published
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:package
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:cdn-import
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:examples
pnpm run test:docs
WRANGLER_SEND_METRICS=false pnpm run preview:docs
pnpm run test:browser
BROWSER=firefox pnpm run test:browser
BROWSER=webkit pnpm run test:browser
pnpm run minio:start
pnpm run minio:publish
pnpm run test:demo --minio
pnpm run test:demo --preview --minio
pnpm run test:matrix
pnpm run minio:stop
```

The preview was checked over HTTP and stopped. MinIO used the digest-pinned
Docker server/client from `versions.json`; its service was stopped after testing
and its data volume preserved. The pre-existing server on port 8087 was left running.

| Check | Executed result |
| --- | --- |
| Unit/release suite | 15 passed: 11 loader/HTTP checks plus four tag, integrity, registry-failure and workflow-gating checks |
| Installed SDK | 12 cases across three engines, both transports, Vite development and nested-base production; types, lazy assets, native equality, cancellation and recovery passed |
| Cross-origin ESM | 12 corpus/transport cases, 72 native comparisons and 27 asset/CORS/CSP/timeout/cancellation/recovery checks passed; app, SDK and graph used distinct origins |
| README | All five TypeScript examples typechecked; all six examples executed against the real regional graph, including the HTML CDN example |
| Documentation | Source-only build without WASM/native/graph inputs; homepage, search, API and guide navigation passed in all three engines; local Pages preview served homepage and Router API |
| Runtime regression | 18 checks per engine, 54 total; real Asyncify suspension, native initialization, serialized calls, range faults, transient failures, cache eviction and CPU/fetch cancellation recovery |
| Demo | Six UI checks in each of development and production preview, including regional MinIO routing and zero-fetch repeated routes |
| MinIO matrix | 25 checks, 72 native comparisons via MinIO and 30 regional comparisons via local HTTP; every one of 240 completed archive GETs was selective 206; two aborted requests also requested proper subranges |
| Release preflight | Valid tag and candidate checks passed; actual public npm lookup returned `published: false`; all five pinned GitHub Action revisions resolved to action metadata |

Native JSON comparison is exact; no output tolerance was introduced. Direct CDN
import tests serve the unpacked tarball locally with ordinary browser security.
They do not claim jsDelivr/UNPKG publication or new public-CDN performance results.
Raw reports and screenshots remain ignored in `test-results/`; no evidence folder
or generated site is committed.

## Sequential MinIO baseline

Measured in the run beginning **2026-09-18 10:09:36 UTC**. The route is
Balzers–Ruggell, 21.838 km, in release
`liechtenstein-2015-v1-101d55d9c93febce`. Each engine/transport has five cold
samples with new workers and isolated browser contexts, plus twenty same-worker
warm samples. Actual origin requests were verified. WASM compilation-cache state
was uncontrolled. No other build or browser suite ran during these measurements.

Cold time below is worker readiness plus host route time. All values are ms.
Module, graph initialization and route fetch-wait columns are cold medians.

| Browser | Transport | Cold p50 / p95 | Warm p50 / p95 | Module | Graph | Fetch wait |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | Indexed TAR | 547.2 / 555.1 | 16.6 / 21.2 | 72.3 | 37.5 | 38.1 |
| Chromium | Individual tiles | 534.3 / 535.8 | 16.7 / 24.1 | 72.5 | 25.9 | 36.2 |
| Firefox | Indexed TAR | 1280 / 1282 | 57 / 58 | 250 | 35 | 36 |
| Firefox | Individual tiles | 1246 / 1263 | 56 / 57 | 248 | 16 | 33 |
| WebKit | Indexed TAR | 1164 / 1189 | 64 / 82 | 61 | 43 | 49 |
| WebKit | Individual tiles | 1107 / 1181 | 65 / 90 | 59 | 24 | 44 |

Every cold route fetched five tiles totaling **1,476,944 bytes**. Every warm
sample made **zero tile fetches** and reported decoded-cache hits. The decoded
cache budget was 32 MiB. WASM capacity high-water was 173,670,400 bytes in
Chromium/Firefox and 173,604,864 in WebKit; these are capacity, not live heap or RSS.

Including metadata, archive sessions reached MinIO nine times / 1,490,166 bytes
in Chromium and eleven times / 1,490,758 bytes in Firefox/WebKit. Individual-tile
sessions reached it seven times / 1,489,574 bytes in each engine. These numbers
exclude SDK delivery. None transferred the whole archive body.

Origin traces also showed identical-range reuse across reload and browser restart
in Chromium/WebKit, but repeated 512-byte origin reads in Firefox. Chromium's
overlapping request fetched the missing 256 bytes; WebKit fetched 512. Individual
objects were reused in all three engines. MinIO lacks Timing-Allow-Origin, so
cross-origin browser transfer sizes remain **unknown**. There was no CDN in this
run. These observations are a local baseline, not a cross-browser cache guarantee
or agreed release performance budget.

## Remaining release work

GitHub Actions has not run this workflow; npm publication, trusted-publisher setup
and Cloudflare Pages deployment have not been performed. The next step is a manual
release-workflow dry run on the intended commit, followed by the one-time owner
setup in [release instructions](releases.md). Tagged production releases then
publish the verified tarball and deploy matching docs to `valhalla-browser-api`.
Physical devices, broader graph coverage and production acceptance remain outside
this workspace migration.
