---
title: Build graph data from OpenStreetMap
---

# Build graph data from OpenStreetMap

This workflow turns a local **OSM PBF extract** into standard Valhalla `.gph`
tiles, Valhalla's native **indexed, uncompressed `graph.tar`**, and the manifest
and runtime configuration required by `valhalla-browser`. Routing remains inside
browser WASM; the resulting files can be served by static HTTP hosting.

Use the builder from this SDK checkout. Graph tiles depend on the native version:
the current runtime pins **Valhalla 3.8.3**, revision
`a60c7cbfc83e073f50887cd27e0109d02e6b64e5`, in `versions.json`.
A graph from an arbitrary newer Valhalla installation is not automatically compatible.
No package installation hook builds graph data.

## Choose an OSM input

Download a small `.osm.pbf` extract from [Geofabrik](https://download.geofabrik.de/)
or another OSM data provider and place it under `build/inputs/`. Start with a city
or small region. Keep the exact input file: the script records its SHA-256, while
a provider's `latest` URL can change. Choose an extract larger than the journeys
you need; searches and detours can touch tiles beyond the eventual route.

For a reproducible first run, use the **July 2015 Liechtenstein** PBF included in
the pinned upstream checkout. Its filename contains `latest`, but that checked-in
file is a historical benchmark, not current navigation data.

Bounds below are **west,south,east,north**, in longitude/latitude degrees. They
declare the SDK's accepted endpoint coverage; they do not clip the input or
guarantee road connectivity. Use your input's actual coverage for other extracts.
For western/southern regions, use `--bbox=-122.6,37.6,-122.2,37.9` so the negative
first value is parsed correctly. Bounds crossing the antimeridian are unsupported.

## Build with the pinned tools

Run from the repository root with Node/pnpm installed and Docker running:

```sh
pnpm install --frozen-lockfile
pnpm run build:native
pnpm run data:osm \
  --pbf build/sources/valhalla/test/data/liechtenstein-latest.osm.pbf \
  --name liechtenstein-2015 \
  --bbox=9.471078,47.047740,9.636217,47.271280
```

The first command installs workspace tools. `build:native` builds the source and
dependency versions pinned by this repository. It does not require cloud access
or credentials. Docker is the reproducible default; its base image and Ubuntu
package snapshot are pinned. The initial image/source downloads need network
access, build disk space and time. Later runs reuse the native tools.

`data:osm` runs `scripts/build-dataset.py` inside that local image as your user.
Pass **repository-relative paths**: the repository is mounted at `/work`. Copy
external inputs into `build/inputs/`, or use the host-native invocation below.
The wrapper does not pull a similarly named image from a registry if it is absent;
run `build:native` first. It never uploads objects or replaces existing datasets.

For your own extract, replace the input, name and bounds:

```sh
# Replace these paths, coordinates and provenance URL for your OSM extract.
pnpm run data:osm \
  --pbf build/inputs/my-region.osm.pbf \
  --name my-region-2026-09 \
  --bbox=-122.6,37.6,-122.2,37.9 \
  --source-url https://data.example.com/my-region-2026-09.osm.pbf \
  --threads 1
```

`--source-url` is optional public provenance, not a download instruction. Do not
put signed URLs or credentials there: it becomes part of the public manifest.
The script rejects URLs with credentials, query parameters or fragments.
The `example.com` URLs in this guide must be replaced with your deployment URLs.

## What the pipeline does

1. Checks the upstream checkout revision and native builder version against the
   SDK's pins, then creates a new working directory under `build/osm-*`.
2. Creates Valhalla's default configuration with the SDK's effective settings.
   It preserves all road hierarchy levels and driving, bicycle and pedestrian
   access; the SDK currently exposes only driving (`auto`).
3. Builds administrative boundaries with `valhalla_build_admins` from the same
   PBF. By default it downloads and checksum-verifies the pinned global timezone
   shapefile, importing it with upstream's `tz_world`/SpatiaLite schema and index.
4. Runs native `valhalla_build_tiles`, then upstream `valhalla_build_extract`.
   The native builder writes `index.bin` at the beginning of the uncompressed TAR.
   An ordinary `tar -cf`, gzip archive, or hand-written index is not a substitute.
5. Cross-checks every native index entry against the real TAR offset/size, tile
   path and GraphId in the tile header, and computes SHA-256 integrity metadata.
   Offsets, sizes and GraphIds stay exact; 64-bit archive offsets become decimal
   strings in JSON. Hashing/copying streams file bodies instead of buffering the
   whole archive in memory.
6. Audits country/timezone assignment on actual graph nodes, writes a build report,
   and installs a complete immutable release directory. Existing releases are
   accepted only if every object is byte-identical.

The admin/timezone databases are build inputs; IDs are baked into graph tiles.
Their local filesystem paths are cleared from the browser configuration. A small
extract may omit country boundaries or connected ways; check audit warnings and
use more complete inputs where necessary. The scripts do not add transit feeds,
elevation data, traffic, or bike-and-train support.

On a small extract, the pinned admin builder may log `admin_access.admin_id`
constraint errors for countries absent from that extract. It attempts to apply
global country rules. Check the named countries, the command's exit status and
the node audit; do not ignore missing assignments inside your coverage. The
historical Liechtenstein example assigns both country and timezone to all 6,980 nodes.

Timezone preparation can be substantial. To reuse an existing compatible database:

```sh
pnpm run data:osm \
  --pbf build/sources/valhalla/test/data/liechtenstein-latest.osm.pbf \
  --name liechtenstein-2015 \
  --bbox=9.471078,47.047740,9.636217,47.271280 \
  --timezone-db build/region/timezones.sqlite
```

That path exists after `pnpm run data:region`; otherwise supply your own compatible
database or omit the option. Default timezone inputs are pinned in
`scripts/region_data.py`. A supplied database is fingerprinted separately, so it
can produce a different release identity even with identical graph bytes.

## Outputs and local use

The command prints the exact release ID, output directory, working directory,
tile count, archive size, source/config hashes and native audit. For example:

```text
public/datasets/YOUR_RELEASE_ID/
  manifest.json
  config.json
  graph.tar
  tiles/0/.../*.gph
  tiles/1/.../*.gph
  tiles/2/.../*.gph
```

The work directory retains `native-config.json`, `archive-config.json`, native
tiles/databases and `build-report.json` for inspection. `--work-dir` selects a
**new, nonexistent** directory; an existing directory is rejected to protect
other builds. `--output` changes the release parent directory. No fixture files
or demo discovery configuration are overwritten. Run `python3 scripts/build-dataset.py
--help` to see all options without Docker.

The supplied Vite development/preview servers already serve `public/datasets/`
with byte ranges, strong SHA-256 ETags and CORS:

```sh
# Requires built WASM; see the workspace development guide for a clean checkout.
pnpm run dev
```

With that server running, configure your app with the exact generated release ID
and coordinates inside its coverage:

```ts
import { createRouter } from 'valhalla-browser';

const router = await createRouter({
  // Replace the sample release directory with the ID printed by data:osm.
  manifestUrl: 'http://localhost:8080/datasets/YOUR_RELEASE_ID/manifest.json',
  transport: 'indexed-tar', // Or 'individual-tiles' for the same graph.
});
// Calculate routes, then await router.dispose() when finished.
```

The URL's immediate parent directory must equal `manifest.release`. In DevTools,
archive requests must be selective `206` responses; repeated routes in the same
worker should reuse decoded tiles. The SDK currently limits manifest/config JSON
to 4 MiB and each tile/index response to 64 MiB. The builder rejects incompatible
sizes; it does not implement planet-scale partitioning or archive sharding.

## Native build without Docker

The Python pipeline itself is not container-specific. On a machine with the same
pinned Valhalla checkout, repository patches and compatible native dependencies,
build `native/CMakeLists.txt` with data tools enabled. The resulting build tree
must provide `native-reference` and `upstream/valhalla_build_tiles` and
`upstream/valhalla_build_admins`. Then run:

```sh
python3 scripts/build-dataset.py \
  --source-dir /path/to/pinned/patched/valhalla \
  --native-dir /path/to/native-build \
  --pbf /path/to/my-region.osm.pbf \
  --timezone-db /path/to/timezones.sqlite \
  --name my-region-2026-09 \
  --bbox=-122.6,37.6,-122.2,37.9
```

Supply a timezone database to avoid needing `curl`, `spatialite_tool` and
`spatialite` in this step. You still need Python 3.9+, Git and host-compatible
native tools built from the pinned source. Linux binaries from the Docker build
cannot execute directly on macOS. The reproducible default uses the pinned container;
host-native dependency setup is operator-managed. Archive timestamps are fixed
by `--source-date-epoch`; paths and execution time do not name releases. Exact
byte reproduction also depends on identical source inputs, patches, native
dependencies, configuration and builder concurrency.

## Static hosting and deployment validators

Follow [Host graph data on object storage](object-storage-hosting.md) for complete
S3, R2 and other-provider setup, including dashboard CORS/cache rules and a bounded
browser range check. The steps below summarize the data publication workflow.

Upload `graph.tar`, `config.json` and `tiles/` below your versioned release path.
Preserve the directory structure and exact graph bytes. Use MIME types
`application/json` for JSON and `application/octet-stream` for graph objects.
Serve graph data without gzip/Brotli/content encoding. Support GET, HEAD and
single HTTP byte ranges; expose Content-Range, Content-Length, Content-Encoding,
ETag and Last-Modified through CORS. Public immutable release objects should use
`Cache-Control: public, max-age=31536000, immutable`; discovery metadata should
revalidate. See the [repository's R2 CORS policy](https://github.com/tobilg/valhalla-browser/blob/main/docs/r2-cors.json)
for an example.

The initial manifest uses SHA-256 ETags, matching the local range server.
**S3/R2/CDN ETags can differ**, including multipart ETags. They are opaque HTTP
validators, not interchangeable with integrity hashes. After uploading graph
objects and before uploading the manifest, read their actual public headers:

```sh
# Replace BOTH the local release path and the public release URL.
pnpm run data:etags \
  --manifest public/datasets/YOUR_RELEASE_ID/manifest.json \
  --base-url https://routing.example.com/datasets/YOUR_RELEASE_ID/ \
  --output build/hosting/manifest.json
```

This reads public HEAD responses, checks sizes/strong validators/no graph content
encoding, and writes a **separate** delivery manifest. It does not upload, read
the whole archive, or change graph hashes. Use a new output path for another run.
HEAD checks do not prove content integrity or browser CORS: the SDK still checks
hashes and strict ranges while routing. Upload that delivery manifest last as
`<release>/manifest.json`, then use its real HTTPS URL in the SDK. Publish new
graph builds at new release paths; do not overwrite an already published manifest.
Keep the original local manifest for the local SHA-256 ETag server.

## Validate and attribute your dataset

Use `native-reference` with the work directory's `native-config.json` and your
own JSONL route requests to establish native results. Compare successful browser
responses and expected no-route/coverage cases through both transports. Include
cross-tile routes and extraction boundaries. The existing regional benchmark
requests apply to its historical graph; new OSM snapshots can legitimately change
routes and must get new references.

For the checked-in PBF, the integration command builds a **fresh release**, computes
fresh native references, and compares exact browser JSON through both transports:

```sh
# After build:native, data:region, build:wasm and build:sdk (see development setup).
pnpm exec playwright install chromium
pnpm run test:data
pnpm run test:data:build
```

`test:data` verifies real native indexes, rejects corrupt/ordinary/compressed archives,
and checks byte-for-byte archive reproduction by upstream's extract builder.
`test:data:build` checks selective `206` downloads and same-worker decoded-cache reuse
as well as native equivalence. It preserves its native inputs under
`build/osm-verification-*` and writes `test-results/dataset-build.json`; temporary
delivery files are removed. These checks also run in the browser-proof CI workflow.

OSM-derived data requires attribution and is distributed under ODbL. Preserve
the source/timezone attribution in your manifest and display OpenStreetMap
attribution in your application. See [OpenStreetMap's licensing page](https://www.openstreetmap.org/copyright)
and the input provider's terms. The SDK software license does not replace data licenses.

Upstream references: [Valhalla tile-building tools](https://github.com/valhalla/valhalla/tree/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/src/mjolnir),
[native extract builder](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/scripts/valhalla_build_extract),
and [timezone builder](https://github.com/valhalla/valhalla/blob/a60c7cbfc83e073f50887cd27e0109d02e6b64e5/scripts/valhalla_build_timezones).
