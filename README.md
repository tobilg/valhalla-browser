# valhalla-browser

Compute Valhalla routes in a browser Web Worker. The ESM package includes
TypeScript declarations, the worker, and compiled WebAssembly. Standard graph
tiles load on demand through HTTP ranges from an indexed TAR, or as individual
`.gph` objects. Routing runs locally; the data host serves static files.

[Demo](https://valhalla-browser.gh.tobilg.com)
[API documentation](https://valhalla-browser-api.gh.tobilg.com)
[Source](https://github.com/tobilg/valhalla-browser) ·
[Release setup](https://github.com/tobilg/valhalla-browser/blob/main/docs/releases.md)

The repository prepares version **0.1.0**. Publication happens through the tagged
release workflow after the initial npm setup; implementation alone does not
publish the package. Until then, use the local tarball instructions below.

## Install and calculate a route

```sh
pnpm add valhalla-browser
# npm install valhalla-browser also works for consumers.
```

No asset-copy plugin, Docker or native compiler is needed in your application.
The worker and WASM are located automatically. All
`https://routing.example.com/datasets/your-release-id/...` URLs below are
placeholders, not a hosted dataset service. Replace the complete manifest URL
with your deployment's actual URL, including its immutable release directory.
That directory must match the manifest's `release` value. Choose route coordinates
inside your dataset's coverage. See the
[data preparation guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/building-graph-data.md)
to build compatible graph data.

Use this in a browser module or Vite application:

<!-- example:quick-start -->
```ts
import { createRouter } from 'valhalla-browser';

const router = await createRouter({
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
});
try {
  const result = await router.route({
    origin: { lat: 47.0666667, lon: 9.5 },
    destination: { lat: 47.2397558, lon: 9.5262874 },
  });
  console.log(result.native);
} finally {
  await router.dispose();
}
```

These coordinates are covered by the **historical July 2015 Liechtenstein
benchmark**, not current navigation data. © OpenStreetMap contributors, ODbL 1.0.
Graphs are supplied separately and are not included in the package.

Results preserve Valhalla's full native JSON: distances in **kilometers**, times
in **seconds**, and leg shapes encoded as **polyline6**. Driving (`auto`), two
locations, English directions, a 30 m correlation radius and minimum
reachability 0 are the validated defaults.

## Travel profiles

The SDK supports **driving** (`auto`, the default), **cycling** (`bicycle`),
**walking** (`pedestrian`), and **truck** (`truck`). Each dataset must advertise
the requested profile in its manifest. `await router.initialize()` returns
`supportedCostings`; older `auto`-only datasets continue to support driving only.
Transit and combined bike-and-train journeys are not supported.

Use `costing_options` for the selected profile. Omit settings to use Valhalla's
defaults. This example uses the same historical Liechtenstein graph:

<!-- example:profiles -->
```ts
import { Router, type RouteRequest } from 'valhalla-browser';

const router = new Router({
  // Replace with your deployment's multi-profile dataset manifest.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
});
const endpoints = {
  origin: { lat: 47.1392862, lon: 9.5227962 },
  destination: { lat: 47.1450, lon: 9.5168 },
};
const requests: RouteRequest[] = [
  { ...endpoints, costing: 'bicycle',
    costing_options: { bicycle: { bicycle_type: 'road', cycling_speed: 24, use_roads: 0.2 } } },
  { ...endpoints, costing: 'pedestrian',
    costing_options: { pedestrian: { walking_speed: 4 } } },
  { ...endpoints, costing: 'truck',
    costing_options: { truck: { height: 2.5, width: 2, length: 6, weight: 5, axle_load: 2, hazmat: false } } },
];
try {
  for (const request of requests) {
    const result = await router.route(request);
    console.log(result.native);
  }
} finally {
  await router.dispose();
}
```

Speeds are km/h, vehicle dimensions are meters, and weights are metric tonnes.
Profile changes reuse the same worker and tile cache. Unknown profiles or profiles
absent from the dataset reject with `UNSUPPORTED_COSTING`; invalid settings reject
with `INVALID_REQUEST`.

See [Travel profiles and options](https://github.com/tobilg/valhalla-browser/blob/main/packages/documentation/guides/travel-profiles.md)
for supported settings, defaults, dataset upgrades, and current limits. This guide
is also included in the generated API documentation.

## Vite and TypeScript

The package exports request, response, option, error and diagnostics types.
Create one router per session and dispose it when the application no longer
needs it. Only one native operation runs at a time; concurrent submissions queue.

<!-- example:typescript -->
```ts
import { Router } from 'valhalla-browser';
import type { RouteRequest, RouteResult, RouterOptions } from 'valhalla-browser';

const options: RouterOptions = {
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
  memoryBudgetBytes: 32 * 1024 * 1024,
};
const request: RouteRequest = {
  locations: [{ lat: 47.0666667, lon: 9.5 }, { lat: 47.2397558, lon: 9.5262874 }],
  costing: 'auto',
};
const router = new Router(options); // Lazy: the engine loads on initialize/route.
try {
  const result: RouteResult = await router.route(request);
  console.log(result.native.trip.summary);
} finally {
  await router.dispose();
}
```

Importing the module is safe without browser globals. Creating a Router requires
a browser; Node routing and server-side WASM execution are not supported.

## Use directly from a CDN

After publishing version 0.1.0, save this as an HTML file and serve it over HTTP.
No bundler is required. Keep the package version pinned in the import URL.

<!-- example:cdn -->
```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Browser-local route</title>
<button id="route">Calculate route</button>
<pre id="result"></pre>
<script type="module">
  import { createRouter } from 'https://cdn.jsdelivr.net/npm/valhalla-browser@0.1.0/dist/index.js';
  const output = document.querySelector('#result');
  const button = document.querySelector('#route');
  button.onclick = async () => {
    button.disabled = true;
    let router;
    try {
      router = await createRouter({
        // Replace with your deployment's versioned dataset manifest URL.
        manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
      });
      const result = await router.route({
        origin: { lat: 47.0666667, lon: 9.5 },
        destination: { lat: 47.2397558, lon: 9.5262874 },
      });
      output.textContent = JSON.stringify(result.native, null, 2);
    } catch (error) {
      output.textContent = `${error.code ?? 'ERROR'}: ${error.message}`;
    } finally {
      await router?.dispose();
      button.disabled = false;
    }
  };
</script>
</html>
```

UNPKG and ordinary static hosting can serve the same distribution. A cross-origin
import uses a small blob module-worker bootstrap; all routing still runs inside
the worker. Serve JavaScript as `text/javascript` and WASM as `application/wasm`,
with CORS permitting your application origin.

For CSP, allow the SDK origin in `script-src` and `connect-src`, the graph origin
in `connect-src`, `blob:` in `worker-src`, and `'wasm-unsafe-eval'` in `script-src`.
If blob workers are disallowed, self-host matching assets and use the overrides
shown below. See the API site's **CDN and CSP** guide for a complete policy.

## Cancel and route again

An AbortSignal or `router.cancel()` terminates the worker, rejects **all** its
outstanding operations and discards its decoded cache. The next route creates
a new worker. Termination also stops uninterrupted native CPU work.

<!-- example:cancellation -->
```ts
import { createRouter, RoutingError } from 'valhalla-browser';

const router = await createRouter({
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
});
const request = {
  origin: { lat: 47.0666667, lon: 9.5 },
  destination: { lat: 47.2397558, lon: 9.5262874 },
};
try {
  const controller = new AbortController();
  const pending = router.route(request, { signal: controller.signal });
  controller.abort(); // In a UI, call this from the Cancel button handler.
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof RoutingError) || error.code !== 'CANCELLED') throw error;
  }
  const recovered = await router.route(request);
  console.log(recovered.native.trip.summary);
} finally {
  await router.dispose();
}
```

## Reuse a session and inspect diagnostics

Keep the router alive between requests to reuse decoded graph tiles. Browser HTTP
cache and CDN cache are separate; repeated range reuse is browser-dependent.

<!-- example:cache -->
```ts
import { createRouter } from 'valhalla-browser';

const router = await createRouter({
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
});
const request = {
  origin: { lat: 47.0666667, lon: 9.5 },
  destination: { lat: 47.2397558, lon: 9.5262874 },
};
try {
  await router.route(request);
  const repeated = await router.route(request);
  console.log(repeated.diagnostics.loader.requests); // Zero for this warm route.
  console.log(repeated.diagnostics.decodedCacheHits);
  console.log(await router.diagnostics());
} finally {
  await router.dispose();
}
```

The cache budget bounds retained decoded tiles, not total worker memory. Heap
high-water diagnostics measure allocated WASM memory capacity, not live objects
or browser RSS. Diagnostics expose tile URLs and IDs; the SDK sends no telemetry.

## Configure transport and handle errors

`indexed-tar` is the default. `individual-tiles` uses full GETs for the same
standard tiles. A session pins a compatible, immutable manifest release.

<!-- example:errors -->
```ts
import { Router, RoutingError } from 'valhalla-browser';

const router = new Router({
  // Replace with your deployment's versioned dataset manifest URL.
  manifestUrl: 'https://routing.example.com/datasets/your-release-id/manifest.json',
  transport: 'individual-tiles',
  timeoutMs: 10_000,
  retries: 2,
  onProgress: event => console.log(event.phase),
  // Optional matching assets hosted on your application's origin:
  // workerUrl: '/sdk/0.1.0/worker.js',
  // wasmUrl: '/sdk/0.1.0/valhalla-browser.wasm',
});
try {
  await router.route({
    origin: { lat: 47.0666667, lon: 9.5 },
    destination: { lat: 47.2397558, lon: 9.5262874 },
  });
} catch (error) {
  if (error instanceof RoutingError) {
    console.error(error.code, error.message, { retryable: error.retryable });
  } else {
    throw error;
  }
} finally {
  await router.dispose();
}
```

Errors distinguish invalid input, coverage, no-route, transport, integrity,
compatibility and cancellation failures. Transient download errors are never
converted into missing tiles or false no-route results. Initialization can be
retried after failure. `timeoutMs` bounds fetches and worker loading; WASM startup
receives at least ten seconds. Relative asset overrides resolve against the page.

## Build graph data from OpenStreetMap

Provide your own compatible OSM-derived graph dataset. The repository includes
`pnpm run data:osm` to build standard tiles, Valhalla's native indexed `graph.tar`,
and the SDK manifest/configuration from an `.osm.pbf` extract. It uses the pinned
native Valhalla tools and preserves access for driving, cycling, walking, and truck routing.

See [Build graph data from OpenStreetMap](https://github.com/tobilg/valhalla-browser/blob/main/docs/building-graph-data.md)
for a reproducible small example, custom extracts, native/container invocation,
coverage bounds, timezone/admin inputs, static hosting and deployment validators.
The same guide is included in the API documentation site's navigation.

## Host graph data on object storage

Use the [object-storage hosting guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/object-storage-hosting.md)
to deploy datasets on S3, R2, MinIO or another compatible provider. It covers
dashboard setup without AWS CLI, bucket CORS, cache rules for entire prefixes,
HTTP metadata, byte ranges, deployment ETags and browser verification. It also
explains stale CORS responses and CDN cache statuses. The guide is included in
the generated API documentation.

## Develop this workspace

Use Node **22.22.2** and the pinned pnpm **12.4.2**. The three packages are the
SDK (`valhalla-browser`), demo (`@tobilg/valhalla-browser-demo`) and documentation
(`@tobilg/valhalla-browser-documentation`). SDK/demo use Vite **8.3.0**.

```sh
pnpm install --frozen-lockfile
pnpm build:docs               # No WASM, native toolchain or graph needed.
pnpm preview:docs             # http://localhost:8081
pnpm build                   # Requires existing verified native artifacts.
pnpm dev                     # http://localhost:8080
pnpm pack:sdk                # build/package/valhalla-browser-0.1.0.tgz
# In another application, before npm publication:
pnpm add /absolute/path/to/valhalla-browser-0.1.0.tgz
```

A clean checkout needs the explicit native/data/WASM build steps in the
[development guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/development.md).
The native pins remain Valhalla **3.8.3** at
`a60c7cbfc83e073f50887cd27e0109d02e6b64e5`, Emscripten **6.0.0**,
Protobuf **21.12** and zlib **1.3.1**. Package consumers do not need this toolchain.

```sh
pnpm test
pnpm test:package
pnpm test:cdn-import
pnpm test:docs
pnpm test:examples
pnpm test:browser
pnpm test:demo
```

The root README is also the TypeDoc homepage and is copied into the npm package.
Set all three package versions with `pnpm run version:set 0.1.0` (or
`npm run version:set -- 0.1.0`), substituting your next stable version. The command
also keeps the SDK version references in this README and the development guide
in sync. See the
[release guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/releases.md)
for the remaining release steps.
Guides and API comments are maintained with the source. Stable version tags
publish the verified SDK through npm trusted publishing, then deploy documentation
to **valhalla-browser-api** and the demo to **valhalla-browser** on Cloudflare Pages. See
[release setup](https://github.com/tobilg/valhalla-browser/blob/main/docs/releases.md)
for the initial npm publication, trust configuration, Pages setup and dry runs.

For the hosted demo, set the GitHub repository variable `VITE_DEMO_MANIFEST_URL`
to your public R2 manifest URL for the Liechtenstein 2015 graph. The build bundles
the same journey presets and downloads graph tiles from that URL. Locally, the
same environment variable can be passed to `pnpm run dev` or `pnpm run build:demo`.

The demo displays routes over an interactive OpenStreetMap basemap with pan/zoom,
endpoint markers, a basemap toggle and a Fit route button. Background map images
come from OSM; routing still runs locally in the WASM worker. The current basemap
may differ from the historical 2015 graph, and synthetic fixture roads are fictional.
See the [development guide](https://github.com/tobilg/valhalla-browser/blob/main/docs/development.md#demo-basemap)
for basemap configuration and hosting requirements.

## Limits and licensing

Desktop Chromium, Firefox and WebKit are the verification targets. Physical
mobile devices, other bundlers and worldwide coverage are not established.
There is no OPFS, IndexedDB, service-worker cache, offline guarantee or external
routing fallback. Bike-and-train routing remains separate discovery work.

See [verification](https://github.com/tobilg/valhalla-browser/blob/main/docs/package-verification.md),
[MinIO testing](https://github.com/tobilg/valhalla-browser/blob/main/docs/minio.md),
and [R2 CORS policy](https://github.com/tobilg/valhalla-browser/blob/main/docs/r2-cors.json).

The SDK is MIT licensed. Compiled dependencies' license texts are included under
`dist/licenses/`; preserve these notices when redistributing the runtime.
