# Notices

This repository is MIT licensed; see `LICENSE`.

The npm distribution includes the compiled runtime and dependency license texts
under `dist/licenses/`. It excludes graph datasets, native tools and MinIO.

The generated runtime incorporates [Valhalla](https://github.com/valhalla/valhalla) (MIT; full license in the pinned checkout's `COPYING`) and its pinned dependencies. Retain upstream notices when redistributing artifacts: Boost Software License 1.0, Protobuf BSD-3-Clause, zlib license, RapidJSON MIT, Howard Hinnant date MIT, unordered_dense MIT, cpp-statsd-client MIT, and notices in the submodule directories. The IANA timezone database carries its upstream public-domain and individual-file notices. Emscripten/LLVM components carry their applicable upstream MIT/University of Illinois and Apache-2.0-with-LLVM-exception notices.

`fixtures/development.osm` is synthetic data authored for this SDK under this repository's MIT license. Its coordinates do not describe a surveyed road network. The demo loads no third-party map tiles. A real OpenStreetMap dataset requires its own OpenStreetMap contributor attribution and ODbL compliance; this synthetic fixture notice is not a substitute.

`ecc521/valhalla-wasm` was reviewed as a community reference. Its prebuilt runtime and route results are not used.

The optional Liechtenstein benchmark uses OpenStreetMap data from July 27, 2015,
included in the pinned Valhalla source. © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
licensed under ODbL 1.0. The native road graph is derived from that database.
The input is reproducible from the pinned source and checksum in `scripts/region_data.py`.
The `timezone-boundary-builder` 2026c polygon input is also ODbL 1.0 and derives
from OpenStreetMap. Its URL and checksum accompany each regional release.
The demo displays attribution; retain it and the data license when distributing
regional graphs. These historical roads are benchmark fixtures, not navigation data.

MinIO Server and MinIO Client are separate local testing tools, pinned by image
digest in `versions.json`, licensed under GNU AGPLv3. They are not bundled into
the browser runtime. Image source versions and upstream links are recorded in
`docs/minio.md`.
