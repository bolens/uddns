# Release playbook

Releases are built from protected `main` by `.github/workflows/release.yml`.
The workflow publishes the exact semantic-version image first, generates its
SBOM, attests and signs the digest, and only then promotes stable releases to
the minor and `latest` aliases.

## Prepare

1. Queue the release PR for squash auto-merge, then confirm it merged after all
   required checks passed:

   ```bash
   gh pr merge --auto --squash --delete-branch
   ```

2. Update local `main` from `origin/main` and require a clean worktree.
3. Choose the next semantic version. Update `package.json` in a separate PR
   when it does not already contain that version, and merge it before tagging.
4. Run `pnpm run verify` at the exact commit to release.
5. Confirm the version has no existing tag or GitHub release:

   ```bash
   version="$(node -p "require('./package.json').version")"
   git ls-remote --exit-code --tags origin "refs/tags/v${version}"
   gh release view "v${version}"
   ```

   Both lookup commands should report that the release does not exist.

## Publish

Create an annotated tag at the verified `origin/main` commit and push only that
tag:

```bash
version="$(node -p "require('./package.json').version")"
git tag -s "v${version}" -m "uDDNS v${version}"
git push origin "v${version}"
```

Do not move or reuse a published release tag. The tag starts the Release
workflow, which rejects tags that do not match `package.json`.

## Verify

1. Wait for the Release workflow to complete successfully:

   ```bash
   gh run list --workflow Release --limit 5
   gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

2. Confirm the GitHub release exists and contains `sbom.spdx.json`:

   ```bash
   gh release view "v${version}" --json tagName,isDraft,isPrerelease,assets,url
   ```

3. Confirm the exact-version container tag resolves. For stable versions,
   confirm the minor and `latest` aliases resolve to the same digest:

   ```bash
   image="ghcr.io/bolens/uddns"
   docker buildx imagetools inspect "${image}:${version}"
   docker buildx imagetools inspect "${image}:${version%.*}"
   docker buildx imagetools inspect "${image}:latest"
   ```

4. Verify the image signature and GitHub attestations using the digest reported
   by the workflow:

   ```bash
   cosign verify \
     --certificate-identity-regexp '^https://github.com/bolens/uddns/' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     "${image}@sha256:..."
   gh attestation verify "oci://${image}@sha256:..." --repo bolens/uddns
   ```

If publication fails, inspect the failed job before retrying it. A retry is
appropriate only when the tagged source is valid and the failure was transient.
When the tagged source needs a fix, leave the failed tag in place, merge the fix
with a new patch version, and publish a new tag. Never move or reuse a release
tag, and never delete or recreate a successfully published tag to repair mutable
aliases.
