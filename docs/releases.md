# SDK releases and Cloudflare Pages

The release workflow is `.github/workflows/release.yml` in
`tobilg/valhalla-browser`. It publishes **valhalla-browser** and deploys documentation
to **valhalla-browser-api**. The demo is a private workspace application and is
not deployed by this workflow. Neither private package nor the workspace root
is published to npm.

## Prepare the accounts once

The unscoped npm package must exist before you can configure its trusted publisher.
For the first version, run **Release SDK and documentation** manually from GitHub
Actions on the intended commit. Manual runs are dry runs: they build native/WASM,
run the verification suites, and upload `sdk-release` and `documentation` artifacts,
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

Create a Cloudflare Pages **Direct Upload** project named `valhalla-browser-api`,
with production branch `main`. Use the dashboard or, when ready:

```sh
pnpm --filter @tobilg/valhalla-browser-documentation exec wrangler login
pnpm --filter @tobilg/valhalla-browser-documentation exec wrangler pages project create valhalla-browser-api --production-branch main
```

Add repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The API
token needs Cloudflare Pages Edit permission for that account. The static site
uses no R2 bindings or storage credentials. Its default address is
https://valhalla-browser-api.pages.dev; a custom domain can be configured later.
See [Pages CI deployment](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

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
Only after publication succeeds does Pages receive the matching documentation
artifact. Deployment uses `--branch main` so tags produce production deployments.

The first bootstrap version can be tagged after configuring trust. Its published
integrity must match the verified candidate; if it differs, do not replace the
published version. Investigate the difference and use a new version when needed.

## Retry and dry-run behavior

An authoritative registry 404 means unpublished. If the version exists and its
name/version/integrity match, publication is skipped and documentation deployment
can continue. A mismatch, registry access error or network failure stops the job.
Rerun failed jobs after correcting the problem; never overwrite a published version.

Manual workflow runs never publish or deploy, including when selecting a tag.
They are suitable for the initial bootstrap and checking the pipeline without
Cloudflare credentials or npm trust. Jobs retain reports and artifacts for 14 days.
Action revisions are pinned. A successful local test is not proof of a hosted CI run.

For explicit documentation-only deployment after account setup:

```sh
pnpm run deploy:docs
```

This command rebuilds and deploys the current checkout. Prefer tagged releases
when documentation must match the published SDK exactly. Preview locally with
`pnpm run build:docs` followed by `pnpm run preview:docs`.
