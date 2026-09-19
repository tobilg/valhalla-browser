---
title: Datasets and transports
---

# Datasets and transports

Pass a versioned manifest URL to `Router` or `createRouter`. It identifies the
Valhalla revision, effective configuration, tile hashes and native archive index.
A session remains pinned to that release. Do not overwrite immutable graph objects.

The README uses `https://routing.example.com/datasets/your-release-id/manifest.json`
as a placeholder. Replace it with your own deployment's complete manifest URL;
the parent directory must match the manifest's `release` value. No public dataset
service is included. Update the example route coordinates for your graph's coverage.

`indexed-tar` fetches whole missing tiles through byte ranges from an uncompressed
native Valhalla TAR. It validates 206, Content-Range, byte length, strong validators,
index entries and SHA-256 before native consumption. An ignored Range response is
rejected before deliberately reading its body. Search can visit tiles beyond the
final route; the loader does not limit requests to a predicted corridor.

`individual-tiles` makes full GETs for the same `.gph` tiles. It provides a useful
comparison when browser HTTP range caching differs. Neither transport changes
routing behavior or the native graph format.

The example release is historical Liechtenstein data from July 2015. Coverage
bounds are not a guarantee of a connected road at every coordinate. Driving,
cycling, walking and truck routing support two locations when advertised by the
manifest. See [Travel profiles and options](travel-profiles.md) for settings and
upgrading older driving-only datasets. Transit timetables are not included.

For your own data, use the pinned native tools and indexed archive builder in
[Build graph data from OpenStreetMap](../../../docs/building-graph-data.md).
Use [Host graph data on object storage](../../../docs/object-storage-hosting.md)
for S3/R2/MinIO setup, CORS and cache policies, deployment validators and browser
checks. Versioned objects should use public immutable caching; discovery metadata
should revalidate.
