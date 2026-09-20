# Experimental Worker example

`index.ts` exposes `POST /route` using a private `GRAPH_DATA` R2 binding. Copy
`index.ts` and `wrangler.jsonc` into your own ESM Worker project **outside this
pnpm workspace**. Replace the bucket name and versioned manifest key in the
configuration. Add authentication/rate limiting before exposing the endpoint.

Install the server package and development tools there:

```sh
pnpm add valhalla-server
pnpm add -D wrangler@4.134.0 typescript@7.0.2
pnpm exec wrangler types worker-configuration.d.ts
pnpm exec wrangler deploy --dry-run --outdir bundle
```

Before npm publication, replace the first command with
`pnpm add /absolute/path/to/valhalla-server-0.1.0.tgz`, using the output of
`pnpm run pack:server` from this repository. The dry-run bundles the static WASM
module without publishing anything. Include the generated configuration types
in your TypeScript project.

`pnpm exec wrangler dev --ip localhost` uses local R2 storage, which starts empty.
The repository's `pnpm run test:server:cloudflare` seeds both development graphs
into actual local Miniflare R2, adapts the manifest to its real ETags, and tests
routing and cancellation without touching your remote bucket. For a first
application check against an existing public dataset, use the HTTP source shown
in the [server guide](../../docs/server-routing.md).

Deployment is a separate owner action. Review the guide's memory, CPU, cancellation
and request-context limits first; this adapter remains experimental.
