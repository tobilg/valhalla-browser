# SDK releases and Cloudflare Pages

The release workflow is `.github/workflows/release.yml` in
`tobilg/valhalla-wasm`. It publishes **valhalla-browser** and **valhalla-server** and deploys documentation
to **valhalla-browser-api** and the demo website to **valhalla-browser** on
Cloudflare Pages. The demo and documentation remain private workspace packages;
neither package, the private shared core, nor the workspace root is published to npm.

Every push to `main` runs the full **Browser routing proof** workflow and uploads
test reports, the SDK candidate, documentation and demo artifacts. These branch pushes
do not publish to npm or deploy either site; publication and deployment remain
part of the tagged release workflow described below.

## Prepare the accounts once

Each unscoped npm package must exist before you can configure its trusted publisher.
For the first version, run **Release SDK, documentation and demo** manually from GitHub
Actions on the intended commit. Manual runs are dry runs: they build native/WASM,
run the verification suites, and upload `sdk-release`, `documentation` and `demo` artifacts,
without publishing or deploying. Download both verified SDK tarballs and `release.json` from `sdk-release`.
The existing browser package already has trust; bootstrap `valhalla-server`
separately before its first tagged publication.

Log into npm as the owner and publish that exact tarball once, using your normal
interactive authentication/2FA:

```sh
npm login
# Use the exact verified candidate version, without rebuilding.
npm publish ./valhalla-server-0.1.0.tgz --access public
```

Do not rebuild the downloaded artifact for this initial publication. Then open
each package's npm settings and add a GitHub Actions trusted publisher:

| Setting | Value |
| --- | --- |
| Organization or user | `tobilg` |
| Repository | `valhalla-wasm` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; this workflow does not select a GitHub environment |
| Allowed actions | Enable direct publish |

Use the actual GitHub repository name, which is independent of the npm package
names. A repository rename changes its OIDC identity; GitHub URL redirects do not
update npm's trusted publisher. If a connection still names `valhalla-browser`,
replace it with the settings above **for both packages**. npm's existing connections
cannot be edited; add a matching connection, then remove the obsolete one.
The packages' `repository.url` must also match `https://github.com/tobilg/valhalla-wasm`.

The CI publisher has `id-token: write` and uses npm CLI 12.0.2 for OIDC and
provenance. Installs, builds, tests and packing use pnpm 12.4.2. Do not add
`NPM_TOKEN` or `NODE_AUTH_TOKEN`; there is no token fallback. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Create Cloudflare Pages **Direct Upload** projects named `valhalla-browser-api`
(documentation) and `valhalla-browser` (demo), each with production branch `main`.
Reuse the existing documentation project if it is already configured. Use the
dashboard or, when ready:

```sh
pnpm --filter @tobilg/valhalla-browser-documentation exec wrangler login
pnpm --filter @tobilg/valhalla-browser-documentation exec wrangler pages project create valhalla-browser-api --production-branch main
pnpm --filter @tobilg/valhalla-browser-documentation exec wrangler pages project create valhalla-browser --production-branch main
```

Add repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The API
token needs Cloudflare Pages Edit permission for that account. Both deployments
reuse these secrets and the documentation package's pinned Wrangler installation.
The sites use no R2 bindings or storage credentials. Their default addresses are
https://valhalla-browser-api.gh.tobilg.com and https://valhalla-browser.gh.tobilg.com;
custom domains can be configured later.
See [Pages CI deployment](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

### Configure the demo's R2 dataset

In the GitHub repository, open **Settings → Secrets and variables → Actions →
Variables → New repository variable** and set:

| Name | Value |
| --- | --- |
| `VITE_DEMO_MANIFEST_URL` | Your public HTTPS URL for the Liechtenstein 2015 dataset's versioned `manifest.json` |

For example, `https://routing.example.com/datasets/your-release-id/manifest.json`
is a placeholder: replace it with your deployed R2 URL. Use the same historical
Liechtenstein graph/configuration prepared by `pnpm run data:region`, with delivery
validators adapted to R2. The release folder must match the manifest's `release`.
This is a public build setting, not a storage credential; Vite embeds it in the
browser JavaScript. Do not put R2 access keys or signed URLs in it.

The Pages artifact includes the app, worker, WASM and all five Liechtenstein
journey inputs from `fixtures/region/requests.json`. It defaults to Balzers–Ruggell
and retains the preset selector, editable coordinates, both tile transports and
OSM attribution. The browser downloads graph data directly from R2 and calculates
routes with WASM. The site does not need `/manifest.json`, `/fixtures/`, `/public/`
or a Vite data server. Graph bytes and precomputed route results are not bundled.
Allow the demo's Pages/custom-domain origin in the R2 CORS policy; see
[object-storage hosting](object-storage-hosting.md) for headers and validators.

CI first runs the local/MinIO tests and a separate static-demo routing test with
the same Liechtenstein graph on another HTTP origin. It then builds the demo with
the repository variable and checks that artifact's startup/presets without
contacting your public R2 deployment. The release job deploys that exact artifact.
Tagged releases fail early if the variable is missing or is not a public HTTPS
URL. Ordinary `main` pushes and manual verification can run without it, producing
the local-development demo. Public R2/CORS availability remains a deployment check.

Changing the variable requires a new build/deployment; setting a runtime variable
in the Pages dashboard will not modify the already-built app.

These are owner setup steps. Implementing the workspace does not execute them.

## Release a version

Set the version of all five workspace packages together:

```sh
pnpm run version:set 0.1.0
# Equivalent npm invocation:
npm run version:set -- 0.1.0
```

Replace `0.1.0` with the desired stable `X.Y.Z` version, without a `v` prefix.
The command validates the argument and reads all inputs before writing them.
The shared core, demo and documentation stay private and share the SDK version. Workspace
dependencies remain `workspace:*`, so the pnpm lockfile does not need an update.
It also updates the pinned SDK CDN URLs, asset paths, tarball filenames and version
text in `README.md` and `docs/development.md`. Historical verification reports and
toolchain versions stay unchanged. It does not build, commit, tag or publish.

Run local verification, commit the change, and push a stable tag
matching the SDK version exactly (for example, after setting `0.1.0`):

```sh
git tag v0.1.0
git push origin v0.1.0
```

Tags trigger validation, then the reusable browser-proof workflow. Malformed,
prerelease and mismatched tags fail before publication. The workflow uses the
pinned source container on an ARM runner and a frozen pnpm lockfile. It does not
change versions or commit build output.

Native/data, WASM/package and documentation jobs run in parallel. The WASM job
packs both candidates and uploads them with one SHA-512 release manifest.
Node and workerd/R2 jobs run alongside the browser jobs; an isolated server
consumer checks Node types without DOM libraries, generated Workers types, real
routing, and Wrangler dry-run bundling. Browser jobs
test that exact tarball across Chromium, Firefox and WebKit, while separate jobs
verify the fresh OSM archive and the MinIO/demo behavior. README examples,
native corpora, fault/recovery suites and TypeDoc remain required checks.
The final `source-build-and-proof` gate rejects failed, cancelled and skipped
prerequisites. Downloaded artifacts are candidates until the entire gate passes.
A publication matrix downloads both verified candidates,
checks both checksums, and independently publishes each missing package to npm's `latest` tag with provenance.
Only after both package publications succeed do separate Pages jobs receive the matching
documentation and demo artifacts. They deploy the tested output without rebuilding.
Deployment uses `--branch main` so tags produce production deployments.

The first bootstrap version can be tagged after configuring trust. Its published
integrity must match the verified candidate; if it differs, do not replace the
published version. Investigate the difference and use a new version when needed.

## Retry and dry-run behavior

An authoritative registry 404 means unpublished. If the version exists and its
name/version/integrity match, publication for that package is skipped and both site deployments
can continue. A mismatch, registry access error or network failure stops the job.
If one package publishes and the other fails, rerun with the same artifacts: the
matching package is skipped and only the missing package is published.
Rerun failed jobs after correcting the problem; never overwrite a published version.

For `ENEEDAUTH`, check each package's **Settings → Trusted publishing** on npm:
the owner, current repository name, workflow filename, optional environment and
permission for direct `npm publish` must match. The workflow prints the expected
identity before publication and enables npm's verbose OIDC diagnostics. It never
prints the OIDC token. Missing GitHub OIDC permissions or a mismatched package
repository now fail before the publish attempt. `npm whoami` cannot verify OIDC.

If only npm's trusted-publisher settings changed, rerun the failed publication
jobs on the existing release run; neither retagging nor a version bump is needed
when both versions remain unpublished. The verified tarballs are reused. A rerun
uses the workflow from the original commit, so workflow-code fixes take effect
only in a new run that references the updated commit.

Manual workflow runs never publish or deploy, including when selecting a tag.
They are suitable for the initial bootstrap and checking the pipeline without
Cloudflare credentials or npm trust. Jobs retain reports and artifacts for 14 days.
A successful local test is not proof of a hosted CI run.

For explicit documentation-only deployment after account setup:

```sh
pnpm run deploy:docs
```

This command rebuilds and deploys the current checkout. Prefer tagged releases
when documentation must match the published SDK exactly. Preview locally with
`pnpm run build:docs` followed by `pnpm run preview:docs`.
