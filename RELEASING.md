# Release playbook

[Documentation](docs/README.md)

uDDNS publishes Semantic Versioning releases and GHCR images from signed
annotated `vX.Y.Z` tags. `package.json` is the version authority.

With `WOODPECKER_PUBLISHING=true`, enable the authenticated broker policy and
full Woodpecker profile together. Native validation precedes the signed-tag
publisher's immutable candidate, SPDX SBOM, and release manifest. The retained
hosted Release bridge verifies the exact native source and image, signs and
attests with GitHub OIDC, then promotes that same digest and publishes the
release. Its separate Pages job builds fresh protected main and verifies an
explicit GitHub Pages build after release publication. Ordinary main Pages
publication runs in Woodpecker; Gitea copies select validation only.

With publication disabled, the hosted Release workflow remains the complete
fallback. Follow [the cutover contract](docs/releasing.md) for activation and
rollback: drain native and hosted publishers, select the validation-only profile,
then clear the publication flag. Do not run two publication owners together.

## Prepare and validate

Create `release/vX.Y.Z` from current `origin/main`. Update the package version
with pnpm so the lockfile stays synchronized. Add reader-visible changes to the
release notes/changelog surface and update schemas, examples, provider docs,
security guidance, and Pages data together when affected.

```sh
pnpm install --frozen-lockfile
pnpm run verify
test "$(node -p 'require(\"./package.json\").version')" = X.Y.Z
```

Default tests must use stubbed providers. Never use live tokens or perform DNS
writes during release validation.

## Review and publish

Do not push directly to `main`. Open a pull request, require all checks, and
squash-merge. Confirm CI succeeds
on the resulting `main` SHA. Create a signed annotated tag on that exact commit
and push it. Do not promote aliases by hand ahead of workflow verification.

## Verify and recover

Verify the release tag and notes, immutable GHCR digest, image
manifest, SPDX SBOM, provenance and SBOM attestations, Cosign signature, and
promoted aliases. Pull by digest into an isolated environment and run config,
health, and dry-run checks without provider writes. Confirm Pages reports the
new release.

Never move a published tag or overwrite an immutable digest. If publication
fails before aliases move, fix the workflow through a PR and retry safely. If a
bad image is public, stop alias promotion and publish a corrected patch version.

Fleet policy: <https://github.com/bolens/.github/blob/main/RELEASING.md>.

## Branch protection

The default branch requires pull requests, resolved conversations, linear
history, and an up-to-date branch with passing required checks, including `CI
result` and `supply-chain`. These rules also apply to administrators; force
pushes and branch deletion are disabled. Zero approving reviews are required
because this is a solo-maintainer repository; review the complete diff before
merging.

Keep required checks available on every pull request. Filter expensive work
inside jobs or use an always-running result job that rejects failures and
cancellations. Update the protection settings when renaming required jobs.

## Source lint

The native Woodpecker core checks maintained Python, JavaScript, and CSS files
selected by [`.github/source-lint.json`](.github/source-lint.json), using
[`scripts/ci/check-fleet.sh`](scripts/ci/check-fleet.sh) and the same pinned fleet
tooling as [the hosted Source lint fallback](.github/workflows/source-lint.yml).
The hosted check runs whenever either `WOODPECKER_LINUX_CI` or
`WOODPECKER_PUBLISHING` is not `true`. After the paired cutover is accepted,
require `ci/woodpecker/pr/woodpecker` with `supply-chain`, `CI result`, and
`Development environment` on the current head, rather than an intentionally
skipped fallback. Retain macOS and actual Docker environment validation.

Use the [shared local reproduction instructions](https://github.com/bolens/.github/blob/7603518f305fb76f7bb1b9979f2692521f633b82/docs/source-lint.md)
with the same pinned tooling revision. Review exclusions when adding source files;
generated and imported files retain their native validation.
