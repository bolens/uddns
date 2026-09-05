# Release playbook

uDDNS publishes Semantic Versioning releases and GHCR images
from `vX.Y.Z` tags. `package.json` is the version authority. The Release
workflow validates source, builds and pushes the immutable image, attaches an
SPDX SBOM and attestations, signs the digest with Cosign, promotes aliases, and
creates the GitHub release.

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
