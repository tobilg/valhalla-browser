# Regional graph and native references

`pnpm run data:region` builds the Liechtenstein extract included in the pinned
Valhalla 3.8.3 checkout. Although its upstream filename contains `latest`, this
input is a fixed **July 27, 2015** OSM snapshot, SHA-256
`b8b6c7f2122bd46a65b1d1c669b47c20df4f784a501ace3221d5ea6053121ecc`.
It is a small real-road benchmark, not current navigation data or a worldwide
performance proxy.

The pipeline runs native `valhalla_build_admins` on the same PBF and imports the
checksummed timezone-boundary-builder 2026c shapefile using the same SpatiaLite
schema and spatial index as upstream's timezone builder. The source URL,
checksums, coverage, enabled modes and configuration fingerprint accompany the
release. The timezone input cache verifies both input and database receipts.
All native hierarchy levels and driving/bicycle/pedestrian graph access remain
enabled; only driving is exposed as a validated SDK costing.

The native audit reads actual graph nodes, not just the database files. It
records **6,980 / 6,980 nodes with timezone and country assignments** across
five tiles. These values are baked into `.gph` tiles; SQLite files are not
shipped to or opened by the browser. Time-dependent requests and transit are
not exposed or validated by this corpus.

The native upstream archive builder emits an uncompressed indexed TAR. The
preparation script cross-checks every `<QII` index entry against the real TAR
member and native graph header before publication. This regional archive is
**1,484,800 bytes**, with an 80-byte native index and 1,476,944 tile bytes.
The long route touches all five tiles; it demonstrates tile-boundary fetching
but does not save much data on such a small region. The synthetic corpus also
proves that an unused tile is never downloaded.

| Case | Native result | Purpose |
| --- | --- | --- |
| Vaduz short | 0.980 km | Short urban route |
| Balzers–Ruggell | 21.838 km | Longer route across tile boundaries |
| Vaduz–Malbun | 13.858 km | Mountain road route and detour |
| Restriction 2366291 | 0.372 km | Actual OSM `no_left_turn` restriction |
| Outside coverage | Native 171 / SDK OUTSIDE_COVERAGE | Declared coverage rejection |

`fixtures/region/requests.json[l]`, `reference.json`, and `manifest.json` record
the exact requests/results and identities. The existing seven-case synthetic
corpus supplies isolated one-way, restriction, disconnected and outside checks.
Native/browser comparisons retain the entire response and require exact JSON
equality: no numerical tolerance or route-alternative exception was needed.
Coverage is the extract's declared bounding box, not a guarantee that every
point inside it has a connected road. OSM references near extraction boundaries
can be incomplete; no neighboring independently built graph is stitched in.

Outputs live under `build/region/` and immutable `public/datasets/` releases;
`public/region.json` is revalidated discovery. A repeat build verifies existing
immutable bytes and checks unchanged requests against the previous native
reference. An executed repeat build matched the archive, manifest and native
reference byte-for-byte. Raw build reports are not committed.

SpatiaLite creation/history metadata makes SQLite **file** hashes vary between
builds. Database hashes are retained in `build/reports/region-audit.json` as build evidence,
not used as immutable graph metadata. Graph release identity includes the
reproducible source/build inputs, effective runtime configuration, revision and
archive hash. The actual graph/archive/reference bytes reproduced exactly.

Attribution: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL 1.0; timezone polygons from
[timezone-boundary-builder 2026c](https://github.com/evansiroky/timezone-boundary-builder/releases/tag/2026c).
See [notices](../NOTICE.md) for redistribution information.
