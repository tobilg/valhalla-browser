---
title: CDN and CSP
---

# CDN and CSP

Import `valhalla-browser` from a bundler or a version-pinned CDN ESM URL. The main
module locates its sibling worker and WASM automatically. Cross-origin workers
use a small blob module with a static import; the bootstrap URL is revoked after
startup, failure or cancellation. SDK import alone does not load the engine.

For an application importing from jsDelivr and loading graph data from its own
deployment, a policy can include the following. Replace the placeholder
`https://routing.example.com` with the actual origin serving your manifest and
graph objects. The README's manifest URLs also require your real release path.

```text
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net https://routing.example.com; style-src 'self'
```

This policy assumes your application code is an external module. The README's
inline HTML example additionally needs a matching script nonce or hash. Set it
for your own script; the SDK does not generate CSP nonces.

If blob workers are prohibited, copy matching `dist/worker.js` and
`dist/valhalla-browser.wasm` assets to your origin and provide `workerUrl` and
`wasmUrl`. Relative overrides resolve against the page URL. Keep `worker-src
'self'`, allow WASM compilation, and permit the graph host in `connect-src`.
`workerFactory` is an advanced override and must implement the same SDK protocol.

Serve JS with `text/javascript`, WASM with `application/wasm`, and CORS on SDK
assets. Keep all distribution files together under an immutable version directory.
SDK JS/WASM can be compressed; graph TAR and tiles must retain exact byte offsets.
For graph hosting, follow [the object-storage guide](../../../docs/object-storage-hosting.md)
for bucket CORS, cache policies and selective-range checks.

Missing assets, blocked CORS/CSP and startup timeouts reject initialization. Fix
the configuration and retry the same Router. Worker loading uses `timeoutMs`;
WASM download/compilation receives at least ten seconds.
