# Local S3 delivery

The test environment uses the actual MinIO Docker image, with the browser
fetching directly from `http://127.0.0.1:19000/valhalla`. The demo/WASM are
served from a different loopback port. There is no route service or S3 proxy.

```sh
pnpm install --frozen-lockfile
pnpm run build:native
pnpm run data
pnpm run data:region
pnpm run build:wasm
pnpm exec playwright install chromium firefox webkit
pnpm run minio:start
pnpm run minio:publish
PORT=8087 pnpm run dev
```

Open <http://localhost:8087/?dataset=minio-region>, select a journey, and calculate
a route. The default regional journey is Balzers–Ruggell, 21.838 km in this
historical graph. Filter `graph.tar` in DevTools to see native header/index
reads and complete-tile ranges. Repeat to observe zero loader requests in the
same worker. The synthetic MinIO dataset provides the smaller six-of-seven-tile
selective-loading proof. Switching dataset disposes the previous worker.

```sh
pnpm test
pnpm run test:browser
BROWSER=firefox pnpm run test:browser
BROWSER=webkit pnpm run test:browser
pnpm run test:demo --minio
pnpm run test:matrix
pnpm run minio:stop
```

`test:matrix` compares both native corpora through both MinIO transports,
checks the regional corpus through local HTTP, tests cancellation/recovery,
benchmarks the real graph, and measures cache reuse across page and browser
restarts. It uses sanitized `mc admin trace` events to count actual origin
requests/body bytes. Run it separately from builds and other tests when
collecting timings. Reports are in `test-results/matrix.json` and
`test-results/demo.json`. Firefox/WebKit fault-suite reports use separate
`browser-firefox.json` / `browser-webkit.json` files.

## Reproducible local service

`versions.json` pins these already executed images:

The registry is `quay.io/minio/...`. Both release manifests have the **same
content digests** as the cached Docker Hub images used for the first test.
Docker Hub's MinIO lookup was denied during clean-machine verification;
the upstream Quay mirror was accessible. The setup uses the verified mirror.

| Tool | Release | Source commit |
| --- | --- | --- |
| MinIO Server | RELEASE.2025-09-07T16-13-09Z | `07c3a429bfed433e49018cb0f78a52145d4bedeb` |
| MinIO Client | RELEASE.2025-08-13T08-35-41Z | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |

Source: [MinIO server](https://github.com/minio/minio/tree/07c3a429bfed433e49018cb0f78a52145d4bedeb)
and [MinIO client](https://github.com/minio/mc/tree/7394ce0dd2a80935aded936b09fa12cbb3cb8096).
Both are AGPLv3 tools, external to the browser artifact.

`minio:start` creates only `valhalla-browser-minio` and the named volume
`valhalla-browser-minio-data`. Port 19000 is bound to loopback. The script
generates credentials in ignored, mode-0600 `build/minio/*.env` files and passes
them to local containers; public assets contain no credentials. Only the
`valhalla` bucket is configured for anonymous read. `minio:stop` stops this
label-verified container and preserves its data. Other Docker services are
untouched. Keep the env files with the persistent volume to retain admin access.

The publisher uploads graph objects before the manifest, then updates discovery.
An existing immutable object must have the expected SHA-256 metadata and length;
otherwise publication fails. It reads the actual ETag from HEAD after upload
and writes a delivery manifest under the same graph release path. Local HTTP
and S3 manifests can have different HTTP validators while naming identical
graph bytes, configuration, and release. Per-tile SHA-256 checks stay mandatory.
An upload is repeatable and will not silently overwrite an immutable release.

## Verified headers and production follow-up

Actual MinIO GET/HEAD responses provide strong opaque ETags, byte ranges,
`Cache-Control: public, max-age=31536000, immutable`, and browser CORS exposing
Content-Range, ETag, size and modification time. Discovery uses `no-cache`.
The pinned MinIO configuration varies on Origin/Accept-Encoding, not Range;
graph objects are uploaded without Content-Encoding. The tests verify these
headers and every archive GET's selective `206` response.

This MinIO does **not** emit `Timing-Allow-Origin`. The report therefore leaves
cross-origin browser transfer/cache sizes unknown and uses origin traces to
establish cache reuse. The ordinary Resource Timing zero fields are not treated
as proof of a cache hit. Trace output retains only an explicit measurement
allowlist; request credentials and bodies are discarded.

For an actual S3/CDN deployment, use HTTPS, preserve these range/cache/CORS
headers, add Timing-Allow-Origin if supported, and measure CDN overfetch and
origin traffic independently. S3 permits a single range per GET; ETags are
validators, separate from this SDK's SHA-256 integrity metadata.
See [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
No cloud service or CDN was provisioned or tested here.

Firefox's measured range-cache behavior makes individual tiles a useful
transport choice for repeated sessions. No automatic browser sniffing or
application-managed persistent cache has been added. Actual handset testing,
cache eviction pressure and provider/CDN measurements remain follow-up work.
