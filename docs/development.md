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

One `pnpm-workspace.yaml` and `pnpm-lock.yaml` cover the private root and three
packages. pnpm 12 stores its package-manager resolution and project resolution as
two YAML documents inside that one lockfile. Required esbuild/workerd build scripts
are explicitly allowed. The exact recent Wrangler/Miniflare versions are explicit
release-age exceptions; other pnpm defaults remain active.

| Package | Build output | Role |
| --- | --- | --- |
| `valhalla-browser` | `packages/valhalla-browser/dist` | ESM SDK and unchanged WASM |
| `@tobilg/valhalla-browser-demo` | `packages/demo/dist` | Vite application consuming workspace exports |
| `@tobilg/valhalla-browser-documentation` | `packages/documentation/dist` | TypeDoc HTML with the root README as homepage |

## Source-only documentation

```sh
pnpm run build:docs
pnpm run preview:docs         # http://localhost:8081
```

Documentation reads the SDK's public TypeScript entry point directly. It does not
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

## Existing native artifacts

```sh
pnpm run build
pnpm run dev                 # http://localhost:8080
pnpm run pack:sdk            # build/package/valhalla-browser-0.0.1.tgz
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
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:package
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:cdn-import
SDK_TARBALL=build/package/valhalla-browser-0.0.1.tgz pnpm run test:examples
pnpm run test:browser
BROWSER=firefox pnpm run test:browser
BROWSER=webkit pnpm run test:browser
pnpm run test:demo
pnpm run test:demo --preview
pnpm run test:demo:static     # Standalone build, bundled Liechtenstein presets, separate graph origin.
```

Without `SDK_TARBALL`, the package/CDN/example tests run `pnpm pack` themselves.
With it, they test the supplied release candidate unchanged. Package tests use an
isolated pnpm consumer, strict typechecks,
nested-base Vite builds, lazy asset loading and real WASM routing. The CDN-import
suite serves the unpacked package, application and graph from separate origins.
README TypeScript examples are extracted and typechecked, then all six examples
run against the local regional graph; only data/SDK host URLs are substituted.

Each installed-package transport case gets a fresh browser context, so independent
consumers do not share page, HTTP-cache or worker state. Within each case, cold and
warm routes use one worker; cancellation and recovery use the same page and Router,
and the replacement worker must download tiles again and match the native result.
`test-results/package.json` includes replacement-worker timings and records failed
cases with their stage, progress events and browser errors. CI retains this report
in the `browser-proof` artifact. To investigate one engine without skipping any of
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

Pushes to `main` only verify and upload artifacts. Tagged releases publish the
same workflow's exact SDK tarball and deploy its matching documentation and demo
artifacts to the `valhalla-browser-api` and `valhalla-browser` Pages projects.
See [release setup](releases.md) for trusted
publishing, initial package setup and manual dry runs. Local passes do not claim
that GitHub Actions, npm publication or Cloudflare deployment has executed.
