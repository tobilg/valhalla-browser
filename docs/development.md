# Workspace development, native builds and verification

Use Node **22.22.2** (`nvm use`) and pnpm **12.4.2**, pinned in the root
`packageManager`. Install this pnpm version directly if an older global pnpm
cannot bootstrap version 12 on macOS:

```sh
npm install -g pnpm@12.4.2
pnpm --version
pnpm install --frozen-lockfile
```

The migration was executed with pnpm 12 directly; the previously installed pnpm
10.33.3 failed its version-12 handoff with ENOEXEC on this Mac. No global package
manager upgrade is performed by repository scripts.

One `pnpm-workspace.yaml` and `pnpm-lock.yaml` cover the private root and five
packages. pnpm 12 stores its package-manager resolution and project resolution as
two YAML documents inside that one lockfile. Required esbuild/workerd build scripts
are explicitly allowed. The exact recent Wrangler/Miniflare versions are explicit
release-age exceptions; other pnpm defaults remain active.

| Package | Build output | Role |
| --- | --- | --- |
| `valhalla-browser` | `packages/valhalla-browser/dist` | Browser ESM SDK and compiled WASM |
| `valhalla-server` | `packages/valhalla-server/dist` | Node and experimental Cloudflare ESM/WASM |
| `@tobilg/valhalla-core` | Bundled into the public SDKs | Private runtime, validation and transport core |
| `@tobilg/valhalla-browser-demo` | `packages/demo/dist` | Vite application consuming workspace exports |
| `@tobilg/valhalla-browser-documentation` | `packages/documentation/dist` | TypeDoc HTML with the root README as homepage |

The SDK's `tsconfig.json` is an editor solution referencing separate client,
Web Worker and Node/Vite configurations. This lets VS Code discover the worker's
WebWorker globals and Emscripten declarations while keeping DOM and Node globals
out of that runtime. `pnpm run typecheck` checks these and the core/server configurations; package
declarations and TypeDoc use `tsconfig.client.json`. After pulling configuration
changes, use **TypeScript: Restart TS Server** in VS Code if old diagnostics remain.

## Source-only documentation

```sh
pnpm run build:docs
pnpm run preview:docs         # http://localhost:8081
```

Documentation reads all three public TypeScript entry points directly. It does not
build or load WASM and needs no native toolchain, graph or Docker. TypeDoc 0.28.20
uses its own TypeScript 6.0.3; SDK compilation stays on TypeScript 7.0.2. Guides
live with the documentation package, API comments live with the SDK source, and
all homepage changes belong in the root README. The local `readme-theme.js` theme
also includes that README above the API index on TypeDoc's project overview
(`modules.html`), which the sidebar project link opens. Both entry points show
the same introduction and examples. TypeDoc warnings fail the build,
including undocumented public declarations, constructors and fields. The SDK is
explicitly selected by `packagesRequiringDocumentation`, since TypeDoc runs from
a different workspace package. The shared [OSM build guide](building-graph-data.md)
and [object-storage hosting guide](object-storage-hosting.md) are also included in
the generated site through `projectDocuments`.
Give every included Markdown guide a YAML frontmatter `title` matching its page
heading; TypeDoc uses it as the readable navigation and search label.
Titles also determine generated document URLs, so rebuild the site after changing
them to update all cross-links.
The SDK build copies the root README/LICENSE/NOTICE into its package for packing.
These copies are ignored; edit the root originals.

## Social previews

Both sites use the shared `assets/og-image.jpg` (1200 × 631 pixels). Vite copies
the shared assets into `packages/demo/dist/`; the TypeDoc theme copies the image
into `packages/documentation/dist/`. Both serve it at `/og-image.jpg`, including
local development/preview. Replace the source image and rebuild both sites to
update it; if its dimensions change, update the image metadata too.

Open Graph and Twitter/X large-image tags are rendered directly into HTML.
The demo's metadata lives in `packages/demo/index.html`; documentation metadata
comes from `packages/documentation/readme-theme.js`, with titles and canonical URLs
for each API/guide page. Public URLs use the domains linked in the README:
`https://valhalla-browser.gh.tobilg.com/` and
`https://valhalla-wasm-api.gh.tobilg.com/`. For another deployment, update the
demo's absolute metadata URLs and TypeDoc's `hostedBaseUrl` in `typedoc.json`.
Local previews retain those public URLs so shared links identify the deployed site.
The documentation header link remains `/`.

## Existing native artifacts

```sh
pnpm run build
pnpm run dev                 # http://localhost:8080
pnpm run pack:sdk            # build/package/valhalla-browser-0.2.1.tgz
```

`build` builds the SDK, demo and documentation. `build:sdk` builds just the SDK;
`build:demo` builds the SDK followed by the demo. `PORT=8087 pnpm run dev` selects
another port. Both Vite development and preview bind to `localhost`.
Demo edits use Vite HMR; rebuild the SDK after editing its source.
The demo resolves the SDK via `workspace:*` and its actual exports, without a
source alias. Its development and preview servers reuse the range-capable graph
handler; graph releases are not copied into the application distribution.

```sh
pnpm run build:demo
pnpm run preview
```

To run or build the demo against the R2 copy of the Liechtenstein 2015 graph,
set `VITE_DEMO_MANIFEST_URL`. Replace the example with your real versioned manifest:

```sh
VITE_DEMO_MANIFEST_URL=https://routing.example.com/datasets/your-release-id/manifest.json pnpm run dev
VITE_DEMO_MANIFEST_URL=https://routing.example.com/datasets/your-release-id/manifest.json pnpm run build:demo
pnpm run preview
```

Alternatively, copy `packages/demo/.env.example` to `packages/demo/.env.local`
(ignored by Git), replace its URL, and restart Vite. The setting is embedded at
build time. The configured demo bundles the five Liechtenstein journey inputs,
defaults to Balzers–Ruggell, and fetches graph data from the supplied manifest;
it needs no local discovery/preset endpoints. Leave the variable unset for the
local fixture/MinIO selectors. Repository CI uses the same variable under GitHub
Actions **Variables**; see [release setup](releases.md#configure-the-demos-r2-dataset).

### Demo basemap

The demo uses Leaflet 1.9.4 and the public OSM raster layer at
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`. Leaflet is bundled only into the
demo; the routing SDK has no new dependencies. The map fits the complete computed
route, marks its endpoints, supports pan/zoom and provides a **Fit route** button.
The **Show basemap** checkbox hides background images while retaining the route.
Unavailable basemap tiles show a separate message and do not prevent routing.

The raster layer uses a warm monochrome CSS filter for muted beige tones, with
a dark green route, white outline and green/charcoal endpoints. The filter is
scoped to `.demo-basemap` in `packages/demo/style.css`, so route overlays and
controls retain their colors. This tones the complete tile image, including its
labels; individual road, water and land colors are baked into the raster tiles.
Remove or adjust that rule when using a provider with its own styled tiles.

Map images are fetched from the tile provider for the visible viewport using
normal browser HTTP caching. The demo preserves a Referer header and displays
linked OSM attribution; it has no map-tile prefetch or offline download feature.
Follow the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
when deploying the demo. These images show current OSM streets: the historical
2015 routing graph can differ, and synthetic fixture roads do not follow real roads.

To use another OSM-derived XYZ raster provider, set `VITE_DEMO_BASEMAP_URL` and,
when required, `VITE_DEMO_BASEMAP_ATTRIBUTION` before running/building Vite. The URL
must contain `{z}`, `{x}` and `{y}` placeholders. Additional attribution is plain
text; the linked OSM credit remains visible. Commented examples are in
`packages/demo/.env.example`. These settings are public build inputs, separate
from the routing graph's `VITE_DEMO_MANIFEST_URL`. A deployment with a Content
Security Policy must allow the tile provider in `img-src`.

Automated demo checks intercept basemap image requests with local test tiles,
including a tile failure case. They never exercise the public OSM tile service;
Valhalla routes and graph downloads remain real.

## Clean native checkout

Docker with a running daemon, Git, network access and build disk space are
required only for these explicit source/data commands:

```sh
pnpm run build:native
pnpm run data
pnpm run data:region
pnpm run build:wasm
pnpm run build
pnpm exec playwright install chromium firefox webkit
pnpm run dev
```

The supplied `external-projects/valhalla` reference remains untouched. Builds use
the pinned source under `build/`, and remain incremental. Native code, patches,
fixtures and shared preparation tools stay at repository root. See
[building graph data from OSM](building-graph-data.md), [regional data](regional-data.md),
and `versions.json` for the custom-data workflow and source/toolchain pins.

SDK builds verify generated glue and WASM against `native/runtime-lock.json` and
include the dependency license texts. There are no consumer install hooks or
runtime npm dependencies. Intentional native changes require rebuilding,
regression verification and an updated artifact record before packaging.

## Verification

```sh
pnpm test
pnpm run test:data            # Requires data and data:region fixture archives.
pnpm run test:data:build      # Fresh OSM build and Chromium/native route comparison.
pnpm run test:docs
pnpm run pack:sdk
SDK_TARBALL=build/package/valhalla-browser-0.2.1.tgz pnpm run test:package
SDK_TARBALL=build/package/valhalla-browser-0.2.1.tgz pnpm run test:cdn-import
SDK_TARBALL=build/package/valhalla-browser-0.2.1.tgz pnpm run test:examples
pnpm run test:browser
BROWSER=firefox pnpm run test:browser
BROWSER=webkit pnpm run test:browser
pnpm run test:search-memory   # Reservation policies, full native corpus, cache and cancellation recovery.
BROWSER=firefox pnpm run test:search-memory
BROWSER=webkit pnpm run test:search-memory
pnpm run benchmark:search-memory # Previous vs current reservations; five cold/twenty warm samples per profile.
pnpm run test:demo
pnpm run test:demo --preview
pnpm run test:demo:static     # Standalone build, bundled Liechtenstein presets, separate graph origin.
```

Without `SDK_TARBALL`, the package/CDN/example tests run `pnpm pack` themselves.
With it, they test the supplied release candidate unchanged. Package tests use an
isolated pnpm consumer, strict typechecks,
nested-base Vite builds, lazy asset loading and real WASM routing. The CDN-import
suite serves the unpacked package, application and graph from separate origins.
README TypeScript examples are extracted and typechecked, then all seven examples
run against the local regional graph; only data/SDK host URLs are substituted.

Each installed-package transport case gets a fresh browser context, so independent
consumers do not share page, HTTP-cache or worker state. Within each case, cold and
warm routes use one worker; cancellation and recovery use the same page and Router,
and the replacement worker must download tiles again and match the native result.
`test-results/package.json` includes replacement-worker timings and records failed
cases with their stage, progress events and browser errors. CI retains this report
in the `browser-proof-<browser>` artifacts. To investigate one engine without skipping any of
its development/production or transport cases, run `BROWSER=webkit pnpm run test:package`.

The package and README consumers install with
`--prefer-offline --no-frozen-lockfile --ignore-scripts`: cached packages are reused, missing registry metadata can be
fetched, and only the temporary consumer gets a new lockfile. A fresh CI runner's
frozen workspace install does not populate all metadata needed to resolve a new
consumer, including its pinned pnpm version; strict `--offline` fails there with
`ERR_PNPM_BAD_CONFIG_DEP`. The repository installation still uses
`pnpm install --frozen-lockfile`, and consumer lifecycle scripts stay disabled.

The docs test also builds an isolated source-only copy, audits internal links and
anchors, and checks homepage, search, API and guide navigation in all three engines.
The data tests read actual native fixture indexes and reject corrupt index entries,
tile headers and incompatible archives; they also check immutable publication.
Public deployment-validator checks run with `pnpm test` using a local HTTP server.
The browser suite preserves full native JSON comparison, actual Asyncify suspension,
range faults, serialized calls, cache bounds and CPU/fetch cancellation recovery.
The native corpora also cover cycling, walking, truck attributes and access
restrictions. Mixed-profile requests share a worker without sharing costing
settings. The matrix benchmarks all four profiles with five cold and twenty warm
samples per transport/browser. `test/profiles.test.js` checks that native fixture
paths actually demonstrate shortcuts, bicycle contraflow and truck detours.
See [road profile verification](profile-verification.md) for the executed baseline
and dataset migration details.
See [search-label memory](search-memory.md) for the smaller SDK defaults and
measurements against those same native corpora. The search-memory suite writes
`test-results/search-memory-<browser>.json` and runs in each browser CI job;
the optional benchmark uses loopback HTTP, with no CDN or R2 measurement.
The browser suite also injects worker-script HTTP failures during cancellation recovery. An
opaque browser load error before the worker's first message, or a WASM startup
timeout during initialization, gets at most one shared retry after 100 ms; the
failed worker is terminated first. Concurrent callers share the replacement.
`retries: 0` or a custom `workerFactory` disables that retry.
Persistent errors still reject, and cancellation/disposal stops the pending retry.
Native routing operations are never replayed. This covers
an intermittent Linux WebKit failure when loading a replacement worker immediately
after termination. The matrix report retains browser errors, failed request URLs
and local asset-server records alongside the MinIO origin trace for diagnosis.
The browser suite delays real WASM responses past the startup watchdog to verify
bounded recovery, capability errors after recovery, and persistent timeout rejection.
Clearing a fault in the CDN test host also releases pending injected delays, so
the recovery attempt runs against a restored origin even if the browser retained
a module download after its original worker terminated.
The static demo report retains the failing engine/transport, completed checks,
UI status, pending/failed requests, and server-side completion records for the
worker script and WASM response. `BROWSER=webkit pnpm run test:demo:static`
isolates that browser without changing assertions or retrying test cases.

Playwright is pinned to **1.63.0** (WebKit **26.6**). On 2026-09-19, the previous
1.58.2/WebKit 26.0 build reproduced the CI initialization timeout on Linux/arm64
at the sixth reload in one context. Both WASM responses finished, but streaming
instantiation stalled through the initial attempt and its retry while the WebKit
process consumed approximately 5.2 GiB of resident memory and four CPUs. This is
consistent with [upstream reports of Asyncify compilation pressure](https://bugs.webkit.org/show_bug.cgi?id=304810),
although the exact WebKit compiler defect was not isolated. The same original
WASM artifact passed ten reloads per transport with WebKit 26.6. The runtime
build flags, startup timeout and retry limit are unchanged; this test-browser
upgrade does not patch older WebKit installations used by SDK consumers.

CI repeats the legacy-profile rejection and native-equivalent driving route ten
times **per transport** in the same WebKit context, following the normal routing
and cancellation checks. Each reload restores the selected transport. To run
that regression locally:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps webkit
BROWSER=webkit DEMO_RELOAD_CYCLES=10 pnpm run test:demo:static
```

`DEMO_RELOAD_CYCLES` accepts 1–100 and defaults to one. Per-cycle startup and route
measurements are saved in `test-results/demo-static.json`; failures still fail
the test immediately, without test-level retries.

To repeat the exact immediate-cancellation sequence with real regional routes:

```sh
pnpm run test:worker-recovery # 10 WebKit cycles against the local graph
# After minio:start and minio:publish:
BROWSER=webkit RECOVERY_CYCLES=100 pnpm run test:worker-recovery --minio
```

Each cycle uses a fresh browser context, then cancels and recovers on the same
Router without test-level retries. Results and browser/network errors are saved
in `test-results/worker-recovery.json`.

The static-demo test compiles an isolated build with the manifest environment
variable, serves only its output, and verifies all regional presets, selective
tile loading, warm reuse and cancellation/recovery in all three browsers. It
does not contact R2 or use the repository's Vite data middleware.

```sh
pnpm run minio:start
pnpm run minio:publish
pnpm run test:matrix
pnpm run test:demo --minio
pnpm run test:demo --preview --minio
pnpm run minio:stop
```

See [MinIO setup](minio.md) for pinned images. Credentials and graphs are excluded
from the package. Stop only the test service you started; preserve unrelated servers.

## Benchmarks, reports and releases

Run browser performance measurements sequentially without other builds/suites.
Reports/screenshots go to ignored `test-results/`; native traces and build inventories
remain in ignored `build/reports/`. CI retains downloadable artifacts. Worker memory,
browser HTTP cache and CDN cache are separate states; unavailable transfer data is
unknown, and WASM capacity is not process RSS.

```sh
pnpm run benchmark
# Replace the sample manifest URL with your own deployment's versioned URL.
pnpm run test:cdn https://routing.example.com/datasets/your-release-id/manifest.json
pnpm run test:cdn:cors https://routing.example.com/datasets/your-release-id/manifest.json
pnpm run test:cdn:objects https://routing.example.com/datasets/your-release-id/manifest.json
pnpm run test:demo --r2
```

`routing.example.com` and `your-release-id` are placeholders. The CDN benchmark
commands compare against the repository's regional native corpus, so deploy that
same graph/configuration and use its real release ID in the URL. For the optional
R2 demo, set `manifestUrl` in your ignored local `public/r2.json` to your own URL;
the SDK does not supply a public dataset service.

The [R2 CORS policy](r2-cors.json) records the cross-origin header policy.

The reusable **Browser routing proof** workflow runs on every push to `main`,
including documentation-only changes, and can also be started manually. It builds
native/WASM artifacts and graphs, runs unit/data tests, verifies the package, CDN
imports, README examples, demo and documentation, and runs the browser and MinIO
suites across Chromium, Firefox and WebKit. Reports and verified artifacts are
retained for 14 days. Public-CDN probes (`test:cdn`, `test:cdn:cors` and
`test:cdn:objects`) remain manual because they require your deployment URL and data;
CI uses local HTTP servers and MinIO for transport verification.

Native graph preparation, WASM compilation/SDK packaging, and documentation run
on separate runners in parallel. The native job also runs the unit/data tests.
Once the build artifacts are available, Chromium, Firefox and WebKit each run
their package, CDN-import, worker and static-demo checks on a separate runner;
the Chromium job also runs the README examples. A separate MinIO/demo job runs
the benchmarks sequentially, without competing browser tests on that runner.
The OSM browser proof consumes a fresh archive and native results from the native
job, so it needs neither a native toolchain nor a Docker image.

To reproduce that OSM handoff locally (use a new bundle directory each time):

```sh
pnpm run test:data:build --prepare build/osm-proof
pnpm run test:data:build --verify build/osm-proof
```

Preparation requires `build:native` and `data:region`; verification requires
`build:sdk` and Playwright Chromium. The existing `pnpm run test:data:build`
command still runs both phases together. The portable bundle contains the actual
generated dataset and native results, and refuses to overwrite an existing directory.

CI passes `native-fixtures`, `browser-runtime`, `osm-proof-input` and the exact
`sdk-release` candidate between jobs. Reports use distinct `browser-proof-*`
artifact names. All artifacts are retained for 14 days. The final
`source-build-and-proof` check retains its previous name for branch protection
and fails if any prerequisite failed, was cancelled or was skipped. Artifacts
uploaded earlier in the run are candidates until this check passes. Parallel
jobs increase concurrent runner use; compare complete hosted run durations before
claiming a speedup.

Pushes to `main` only verify and upload artifacts. Tagged releases publish the
same workflow's exact SDK tarball and deploy its matching documentation and demo
artifacts to the `valhalla-browser-api` and `valhalla-browser` Pages projects.
See [release setup](releases.md) for trusted
publishing, initial package setup and manual dry runs. Local passes do not claim
that GitHub Actions, npm publication or Cloudflare deployment has executed.

## Shared core and server adapters

The five lockstep packages are `valhalla-browser`, `valhalla-server`, the private
`@tobilg/valhalla-core`, the demo and documentation. Public packages bundle the
private core and relocate its declarations; it is never a consumer dependency.

Both SDKs declare core as a `workspace:*` development dependency and import its
package exports, for example `@tobilg/valhalla-core/engine`. Use these exports
instead of relative paths into another package's `src` directory. Packaging
bundles the core JavaScript and emits its declarations into each SDK's
`dist/core`, rewriting type imports to local `.js` paths. No separate core
build or publication is required.

Use `pnpm run build:sdks`, `pnpm run pack:server`, `pnpm run test:server:node`,
`pnpm run test:server:cloudflare` and `pnpm run test:server:package`. The browser
`build:sdk`/`pack:sdk` aliases remain available. Server setup and resource limits
are documented in [Node.js and Cloudflare Workers](server-routing.md).

The native build emits one ABI-3 `valhalla.js` / `valhalla.wasm` runtime shared by
browser, Node and Cloudflare. Host adapters supply compilation/instantiation and
imported memory, bounded by the binary's 1,024 MiB ceiling. The link-time library
`native/runtime-library.js` provides Web Crypto entropy and teaches Emscripten's
growth policy the instance's configured maximum. The browser package retains its
existing `valhalla-browser.wasm` public asset name; both packages contain one
copy of the same binary. The wrapper passes the upstream actor interrupt callback through
Asyncify; no search algorithm patches are needed. `native/runtime-lock.json`
records exact generated glue/WASM bytes for all targets. Update that record only
after a pinned source build and meaningful runtime verification.
