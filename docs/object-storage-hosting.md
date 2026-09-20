---
title: Host graph data on object storage
---

# Host graph data on object storage

Serve a `valhalla-browser` dataset from **Amazon S3, Cloudflare R2, MinIO, or
another HTTP object store**. Routing runs in the browser; storage only delivers
immutable files. Start with the [OSM graph-building guide](building-graph-data.md)
if you do not have a dataset yet.

The setup below uses provider dashboards and public HTTP checks. **AWS CLI is not
required.** CORS is a bucket-level policy; caching can be configured for a whole
URL prefix. You do not need to edit cache headers on every object individually
when your CDN provides the rules described below.

Replace every `routing.example.com`, `app.example.com` and `YOUR_RELEASE_ID` with
your deployment values. These are examples, not a hosted routing service.

## 1. Preserve the release layout

Upload beneath one immutable prefix, with the release directory matching
`manifest.release` exactly:

```text
https://routing.example.com/datasets/YOUR_RELEASE_ID/
  manifest.json
  config.json
  graph.tar
  tiles/0/.../*.gph
  tiles/1/.../*.gph
  tiles/2/.../*.gph
```

Upload `graph.tar`, `config.json` and `tiles/` first. Prepare the delivery manifest
from their real public ETags, then upload `manifest.json` last, as described below.
When uploading a folder through a dashboard, check the resulting object keys:
do not accidentally create `YOUR_RELEASE_ID/YOUR_RELEASE_ID/`.

The browser must have anonymous read access through the final HTTPS URL. The SDK
uses `credentials: 'omit'`; bucket credentials, signed cookies and private access
tokens are not part of this setup. A private S3 origin behind a public CloudFront
distribution works. CORS alone does not grant read permission or make data private.
Keep upload credentials outside browser assets.

## 2. HTTP response requirements

These are the current SDK's checks, regardless of provider:

| Request or object | Required behavior |
| --- | --- |
| Manifest and config GET | `200`, valid JSON; configuration bytes must match the manifest hash. |
| Archive HEAD | `200`, full-object `Content-Length`, matching strong `ETag`, valid `Last-Modified`. |
| Archive GET with `Range: bytes=start-end` | `206`, exact `Content-Range: bytes start-end/TOTAL`, matching strong `ETag`, exact requested bytes. A `200` whole-object response is rejected. |
| Individual `.gph` GET | `200`, complete tile bytes, matching strong `ETag` and SHA-256. |
| Graph payload encoding | No `Content-Encoding`, or `identity`; no gzip, Brotli or Zstandard on TAR/tiles. |
| Response length | Preserve `Content-Length`. HEAD requires the full archive size; a range response's length is the selected byte count. |
| Cross-origin responses | Allow the app origin and expose the headers listed in the CORS policy below, including on HEAD and `206`. |

Use `application/json` for JSON and `application/octet-stream` for graph TAR and
tiles. `Accept-Ranges: bytes` is useful advertising, but only a real range GET
proves support. Leave `ETag`, `Last-Modified`, `Content-Length` and `Content-Range`
to the storage/CDN implementation; never replace them with guessed static values.
Do not apply an SPA fallback or rewrite missing graph objects to an HTML page.

| Files | Recommended browser response header |
| --- | --- |
| All successfully published files beneath `/datasets/YOUR_RELEASE_ID/`, including manifest/config | `Cache-Control: public, max-age=31536000, immutable` |
| Optional mutable discovery file outside that prefix, such as `/current.json` | `Cache-Control: no-cache` |
| Failed/missing-object responses | `Cache-Control: no-store`; avoid long CDN error TTLs. |

A discovery file belongs to your app: resolve it to a versioned manifest URL
before creating a Router. Do not pass discovery JSON as the SDK manifest. Publish
new graph builds at new paths; provider object versioning does not replace URL
versioning. Finalize validators before publishing the immutable manifest.

## 3. Bucket CORS policy

For public datasets, this policy allows any application origin without cookies.
The repository's [R2 CORS JSON](https://github.com/tobilg/valhalla-wasm/blob/main/docs/r2-cors.json)
is the same policy and can also be pasted into the S3 console:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"],
    "ExposeHeaders": [
      "Content-Range", "Content-Length", "Content-Encoding", "ETag",
      "Last-Modified", "Accept-Ranges", "Cache-Control", "Age",
      "CF-Cache-Status", "CF-Ray", "Timing-Allow-Origin"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

To restrict browser origins, replace `AllowedOrigins` with, for example,
`["https://app.example.com", "http://localhost:8080"]`. An origin has no path or
trailing slash; scheme, hostname and port matter. `localhost` and `127.0.0.1`
are different origins. Make sure a CDN does not reuse a response authorized for
one origin as the CORS response for another; use its CORS-aware policy/cache key
or a fixed public wildcard policy.

`AllowedHeaders` permits request headers; `ExposeHeaders` lets JavaScript read
response headers. A header visible in DevTools can still be hidden from the SDK.
The object store handles preflight OPTIONS; do not add `OPTIONS` to S3/R2's
`AllowedMethods` array. A proxy/CDN must allow OPTIONS to reach that handler.
`MaxAgeSeconds` caches preflight permission, not graph bytes.
See [S3 CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html)
and [R2 CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/).

For cross-origin performance diagnostics, optionally serve **`Timing-Allow-Origin: *`**
as an actual response header. Listing its name in `ExposeHeaders` does not create
it or grant Resource Timing access. Without it, zero transfer-size fields can mean
restricted visibility rather than a cache hit.
See [Timing-Allow-Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Timing-Allow-Origin).

## 4. Cloudflare R2: dashboard setup

### Public domain and CORS

In **R2 → your bucket → Settings**, connect your custom domain under public
access, then save the policy above under **CORS Policy**. Use that custom domain
for the SDK and validator checks. The `r2.dev` development endpoint does not
provide Cloudflare CDN caching.
See [R2 custom-domain caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/).

### Cache an entire dataset prefix

In your domain's **Caching → Cache Rules**, create a rule with this expression:

```text
(http.host eq "routing.example.com" and starts_with(http.request.uri.path, "/datasets/"))
```

Reserve `/datasets/` for immutable releases. Keep discovery and the demo HTML
outside it. Do not restrict this rule to GET in the expression; HEAD checks and
purge behavior need consistent matching.

For a dashboard-only setup without per-object `Cache-Control` metadata, use:

| Setting | Value |
| --- | --- |
| Cache eligibility | Eligible for cache |
| Edge TTL | Override origin cache-control with one year (`31536000` seconds). |
| Status-code TTL | Set `400–599` to no-store so failures are not retained for a year. |
| Browser TTL | Respect origin; the response-header rule below supplies browser caching. |
| Cache key | Keep the standard key initially. |

If your uploader already sets the correct cache headers, have Edge TTL respect
them instead and omit the cache-header transform. Check rule order for later
overrides. Eligibility allows caching but does not guarantee retention or HITs.
See [Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

### Browser headers without editing each object

Under **Rules → Transform Rules → Modify Response Header**, create a rule for
successful dataset responses:

```text
(http.host eq "routing.example.com"
 and starts_with(http.request.uri.path, "/datasets/")
 and http.response.code in {200 206 304})
```

Use **Set static** for `Cache-Control` with value
`public, max-age=31536000, immutable`. Optionally set `Timing-Allow-Origin` to `*`
in the same rule. The status condition avoids attaching immutable browser caching
to an error page. Keep bucket CORS responsible for access-control headers.

This transform changes what browsers receive; it does **not** determine whether
Cloudflare caches the object. That is why the separate Cache Rule is needed.
See [response-header transforms](https://developers.cloudflare.com/rules/transform/response-header-modification/)
and [available response fields](https://developers.cloudflare.com/rules/transform/response-header-modification/reference/fields-functions/).
Response-field availability can depend on your plan. If the status condition is
unavailable, use upload-time cache metadata instead of removing that condition
and making error pages immutable. See [response status field availability](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.response.code/).

### Preserve raw graph bytes and refresh old responses

Keep uploads uncompressed. Add a **Compression Rule → Disable compression** for
this graph-only prefix, or specifically `.tar`/`.gph` paths if it contains other
assets. Removing a `Content-Encoding` header from compressed bytes is not a fix.
See [compression settings](https://developers.cloudflare.com/rules/compression-rules/settings/).

After changing bucket CORS, purge existing CDN entries for the affected objects.
Start with **Caching → Configuration → Custom Purge → URL**, using each affected
full URL. Custom cache keys can require additional purge headers or a scoped
hostname/prefix purge; do not purge an unrelated shared zone unnecessarily.
Cloudflare documents [cached R2 CORS responses](https://developers.cloudflare.com/r2/buckets/cors/)
and [single-file purge limitations](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/).

A CDN purge does not clear browser caches. Retest with a fresh browser context
for CORS/header changes; use a new release URL for changed dataset bytes.
See [browser versus edge TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/).

## 5. Amazon S3, with or without CloudFront

In **S3 → bucket → Permissions → Cross-origin resource sharing → Edit**, paste
the policy above and save it. Read permissions remain a separate setting.
See [the S3 console procedure](https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html).

For production HTTPS delivery through CloudFront, use an S3 bucket origin with
**Origin Access Control (OAC)** and the generated read-only bucket policy scoped
to that distribution. The browser-facing distribution can be public while S3
stays private. Use the regular S3 origin, not the S3 website endpoint, for OAC.
See [CloudFront access to S3](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

For a directly public S3 endpoint, permit anonymous `s3:GetObject` only on the
intended dataset prefix; bucket/account public-access settings must allow that
policy. Public write or bucket-list access is not required. Test the final
regional HTTPS object URL, not a console link.

Set HTTP metadata when uploading in the console: select **Properties → Metadata**
and use **System defined** `Cache-Control` and `Content-Type`. A user-defined
`x-amz-meta-cache-control` value is not an HTTP caching policy. Upload graph files
and JSON in separate batches if applying a common MIME type. One upload selection
can carry shared cache metadata; each file does not need a separate manual edit.
See [S3 upload properties](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html).

For the CloudFront `/datasets/*` behavior:

- Allow GET, HEAD and OPTIONS. Forward CORS request headers with the managed
  **CORS-S3Origin** origin request policy.
- Attach a response headers policy with the same allowed origins and exposed
  headers as above, with CORS origin override enabled so that policy controls
  the final headers. A basic CORS policy that omits ETag exposure is insufficient.
- Disable automatic compression for graph delivery. Use a cache policy that
  permits the one-year origin TTL. Keep any discovery behavior revalidated or
  use caching disabled, with minimum TTL zero.
- Keep error caching short. Use the grouped upload metadata above for
  `Cache-Control`; a static response-header policy also applies to error
  responses and should not mark them immutable. Response headers alone do not
  configure CloudFront's cache.

See [managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)
and [response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html).
CloudFront can fetch a larger origin range than the browser requested; measure
origin traffic separately from browser transfer. A chunked origin response can
also make CloudFront return the whole object, which the SDK rejects.
See [CloudFront range behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RangeGETs.html).

## 6. MinIO and other providers

The repository includes [local MinIO setup and verification](https://github.com/tobilg/valhalla-wasm/blob/main/docs/minio.md).
`pnpm run minio:start` and `pnpm run minio:publish` configure the pinned local
service, upload both test datasets, set cache metadata, and capture real ETags.
Follow that guide for its build prerequisites and tests.

For another S3-compatible provider, translate the bucket CORS policy into its
dashboard/API format and use upload-time HTTP metadata or CDN prefix rules for
caching. For stores with a different API, the same HTTP response table applies,
but the CORS configuration format may differ. Verify the public delivery endpoint:
S3-compatible upload APIs do not by themselves prove correct browser range/CORS
behavior. If a provider cannot deliver valid ranges, use `individual-tiles` and
validate full tile GETs; do not download the whole TAR as a fallback.

## 7. Prepare the delivery manifest

The local builder writes SHA-256 ETags for the repository's range server. Storage
providers may use different strong validators, including multipart ETags. Keep
SHA-256 integrity fields unchanged and read the real ETags from the final delivery
host after graph objects have been uploaded:

```sh
# Replace the local release path and public URL. This writes locally; it does not upload.
pnpm run data:etags \
  --manifest public/datasets/YOUR_RELEASE_ID/manifest.json \
  --base-url https://routing.example.com/datasets/YOUR_RELEASE_ID/ \
  --output build/hosting/manifest.json
```

Upload that output as `datasets/YOUR_RELEASE_ID/manifest.json` last. Preserve the
original local manifest for local testing. The helper uses HEAD only and checks
size, encoding and strong ETags; it does not validate browser CORS, ranges or
every object's content hash. It refuses to overwrite its output; use a fresh
local output path for another preparation run. If graph objects or their HTTP
validators change after publication, create a new immutable delivery release
and keep its manifest release/path consistent; do not silently rewrite a live
manifest under year-long cache headers.

## 8. Verify the final public URL

Inspect headers with an actual Origin. R2 may omit CORS headers on requests that
do not include one:

```sh
# Replace these with the final delivery host, release, and allowed application origin.
DATASET_BASE='https://routing.example.com/datasets/YOUR_RELEASE_ID'
APP_ORIGIN='http://localhost:8080'
curl --head --silent --show-error --max-time 15 \
  -H "Origin: $APP_ORIGIN" "$DATASET_BASE/graph.tar"
```

HEAD does not prove that GET ranges work. Run this in DevTools on your **application
page** (for local development, `http://localhost:8080`), replacing the URL. It
checks browser-visible headers and validates just the archive's 512-byte header:

```js
await (async () => {
  const manifestUrl = 'https://routing.example.com/datasets/YOUR_RELEASE_ID/manifest.json';
  const options = () => ({ credentials: 'omit', signal: AbortSignal.timeout(15000) });
  const metadata = await fetch(manifestUrl, options());
  if (metadata.status !== 200) throw new Error(`Manifest HTTP ${metadata.status}`);
  const manifest = await metadata.json();
  const url = new URL(manifest.archive.url, manifestUrl);
  const head = await fetch(url, { ...options(), method: 'HEAD' });
  if (head.status !== 200 || head.headers.get('content-length') !== manifest.archive.size ||
      head.headers.get('etag') !== manifest.archive.etag ||
      !Number.isFinite(Date.parse(head.headers.get('last-modified') ?? '')))
    throw new Error('Archive HEAD metadata or exposed headers do not match');
  const part = await fetch(url, { ...options(), headers: { Range: 'bytes=0-511' } });
  if (part.status !== 206 ||
      part.headers.get('content-range') !== `bytes 0-511/${manifest.archive.size}` ||
      part.headers.get('etag') !== manifest.archive.etag ||
      ![null, 'identity'].includes(part.headers.get('content-encoding'))) {
    await part.body?.cancel(); // Reject an ignored Range before reading the archive body.
    throw new Error('Invalid range, validator, encoding or exposed CORS headers');
  }
  const reader = part.body.getReader();
  const bytes = new Uint8Array(512);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) throw new Error('Oversized range body');
      bytes.set(value, length); length += value.length;
    }
  } finally { await reader.cancel(); }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (length !== 512 || hash !== manifest.archive.headerSha256) throw new Error('Archive header integrity failed');
  console.log({ release: manifest.release, checkedBytes: length, cacheStatus: part.headers.get('cf-cache-status') });
})();
```

Then calculate an in-coverage route through each transport and repeat it in the
same worker. Check that archive GETs remain `206`, complete missing tiles are
loaded, and the repeated route reuses decoded tiles. This small header probe is
not a substitute for routing or a CDN benchmark. The repository's `test:cdn*`
commands compare its historical regional corpus; do not use those expected routes
for an unrelated custom graph.

## Troubleshooting and cache measurements

| Symptom | Check |
| --- | --- |
| Browser CORS error but URL opens directly | Test with the app's Origin; verify exposed headers on HEAD and `206`, and purge stale CDN variants after CORS changes. Also check whether a denied/missing object is hidden by CORS. |
| `DATASET_MISMATCH` | Check release nesting, real public ETags, archive HEAD length and config hash. Regenerate delivery metadata before publication. |
| `RANGE_UNSUPPORTED` / `INVALID_RANGE` | Check for ignored Range, redirects to a download page, compression, proxy rewriting or wrong Content-Range. |
| `CORRUPT_TILE` | Compare uploaded bytes and manifest SHA-256; check encoding and mixed release files. |
| `CF-Cache-Status: BYPASS` | Inspect origin cache directives, Set-Cookie, Vary, object-size limits and applicable rules. A response-header transform cannot repair edge-cache eligibility. |
| `DYNAMIC` / persistent `MISS` | Inspect cache eligibility/rule order; an initial MISS is normal. Purging removes entries but does not change the caching policy. |
| Zero transfer sizes or replayed HIT headers | Separate browser cache, CDN cache and same-worker memory reuse; use Timing-Allow-Origin and provider logs where available. |

Cloudflare describes [cache status causes](https://developers.cloudflare.com/cache/concepts/cache-responses/)
and [range delivery requirements](https://developers.cloudflare.com/cache/reference/range-requests/).
Its [cacheable object-size limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#cacheable-size-limits)
can affect large archives even when object storage accepts the upload. Do not
assume that requesting a small range makes an oversized archive cacheable.

Measure an identical range, an overlapping range and reuse after reload with
browser caching enabled; keep the browser/device, headers and sample counts in
your report. CDN origin fetches can exceed client-requested bytes. Browser `206`
caching is implementation-dependent, and a cached `CF-Cache-Status` value can be
replayed without a new CDN request. Use `individual-tiles` as a comparison under
the same graph/configuration. No persistent offline storage is required.

If hosting the SDK assets as well, serve JS as `text/javascript` and WASM as
`application/wasm`, with CORS and versioned asset paths. Their compression is
independent of the uncompressed graph requirement. See
[CDN and CSP](../packages/documentation/guides/cdn-and-csp.md) for worker loading
and application CSP settings.
