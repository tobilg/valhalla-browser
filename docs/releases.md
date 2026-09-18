# SDK releases and Cloudflare Pages

The release workflow is `.github/workflows/release.yml` in
`tobilg/valhalla-browser`. It publishes **valhalla-browser** and deploys documentation
to **valhalla-browser-api** and the demo website to **valhalla-browser** on
Cloudflare Pages. The demo and documentation remain private workspace packages;
neither package nor the workspace root is published to npm.

Every push to `main` runs the full **Browser routing proof** workflow and uploads
test reports, the SDK candidate, documentation and demo artifacts. These branch pushes
do not publish to npm or deploy either site; publication and deployment remain
part of the tagged release workflow described below.

## Prepare the accounts once

The unscoped npm package must exist before you can configure its trusted publisher.
For the first version, run **Release SDK, documentation and demo** manually from GitHub
Actions on the intended commit. Manual runs are dry runs: they build native/WASM,
run the verification suites, and upload `sdk-release`, `documentation` and `demo` artifacts,
without publishing or deploying. Download the verified SDK tarball from `sdk-release`.

Log into npm as the owner and publish that exact tarball once, using your normal
interactive authentication/2FA:

```sh
npm login
npm publish ./valhalla-browser-0.0.1.tgz --access public
```

Do not rebuild the downloaded artifact for this initial publication. Then open
the package's npm settings and add a GitHub Actions trusted publisher:

| Setting | Value |
| --- | --- |
| Organization or user | `tobilg` |
| Repository | `valhalla-browser` |
| Workflow filename | `release.yml` |
| Environment | Leave empty; this workflow does not select a GitHub environment |
| Allowed actions | Enable direct publish |

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

Update the SDK package version, version-pinned README CDN/asset examples and other
current release examples. The private demo/documentation packages have no separate
release version. Run local verification, commit the change, and push a stable tag
matching the SDK version exactly:

```sh
git tag v0.0.1
git push origin v0.0.1
```

Tags trigger validation, then the reusable browser-proof workflow. Malformed,
prerelease and mismatched tags fail before publication. The workflow uses the
pinned source container on an ARM runner and a frozen pnpm lockfile. It does not
change versions or commit build output.

The source job packs a single candidate, checks its contents, runs installed-package,
CDN-import and README tests against that exact tarball, and uploads it with a
SHA-512 release manifest. It also verifies the demo, native corpora, fault/recovery
suites, MinIO and TypeDoc. The publication job downloads the verified candidate,
checks its checksum, and publishes it to npm's `latest` tag with provenance.
Only after publication succeeds do separate Pages jobs receive the matching
documentation and demo artifacts. They deploy the tested output without rebuilding.
Deployment uses `--branch main` so tags produce production deployments.

The first bootstrap version can be tagged after configuring trust. Its published
integrity must match the verified candidate; if it differs, do not replace the
published version. Investigate the difference and use a new version when needed.

## Retry and dry-run behavior

An authoritative registry 404 means unpublished. If the version exists and its
name/version/integrity match, publication is skipped and both site deployments
can continue. A mismatch, registry access error or network failure stops the job.
Rerun failed jobs after correcting the problem; never overwrite a published version.

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
