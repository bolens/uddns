# Release playbook

[Documentation](README.md)

The default release owner remains `.github/workflows/release.yml` until the
Woodpecker cutover below is accepted and `WOODPECKER_PUBLISHING=true` is enabled.
It builds from protected `main`, publishes the exact semantic-version image,
generates its SBOM, and signs/attests the digest before alias promotion.

## Woodpecker cutover

The staged configuration uses `.woodpecker/woodpecker.yml` for validation,
`.woodpecker/publishing.yml` for canonical signed GitHub tags and
`.woodpecker/pages.yml` for canonical protected-main Pages. PR, manual, cron and
Gitea events do not select publisher steps or credentials. The server broker must
approve the event and the canonical repository variable `WOODPECKER_PUBLISHING`
must explicitly enable delivery. Until native checks, broker policy and hosted
bridges pass acceptance, keep that flag off and retain the legacy owners.
Coordinate broker/flag enforcement and owner transition before merging these
active configuration files; a missing broker credential fails closed. Switch
Pages to the verified `gh-pages` branch source after the first validated native
push creates it. The activation flag disables legacy tag publication and hosted
ordinary Pages deployment while preserving the thin hosted release bridges.
Gitea mirrors keep credential-free validation.

A signed annotated version tag reachable from protected main starts native
validation and a socket-free Kaniko candidate build. The broker provides
`ghcr_username`/`ghcr_password` only to the exact pinned Kaniko plugin, and an
opaque `github_publish_lease` only on approved protected refs. Candidate metadata
binds the source, platform, image/config digests, SPDX inventory and native SLSA
builder statement. The approved App creates or resumes a matching draft without
replacing uploaded bytes, dispatches the hosted bridge and exits pending.

The bridge requires the complete successful native tag pipeline before testing
its exact image digest offline. It retains the existing GitHub OIDC signing
identity and attests the external Woodpecker builder accurately. Only then may it
promote the immutable version, advance a matching minor without downgrading, and
advance global `latest` for a newer stable release. Backports explicitly avoid
becoming GitHub's latest release. `WOODPECKER_STATUS_CREATOR_ID` must be the
verified native status creator; `WOODPECKER_STATUS_PREFIX` defaults to
`ci/woodpecker`. Other pipelines or creators cannot satisfy these checks.

Release publication uses the hosted job's repository-scoped token. Because such
publication does not trigger another release workflow, a dependent hosted job explicitly
fetches fresh protected-main site sources, renders the current latest stable
release, runs credential-free accessibility/link/viewport checks, and appends
`gh-pages` with `.nojekyll`. It rechecks both main and latest-release identities
immediately before pushing. A built-in-token branch push also does not trigger
Pages, so this dependent job requests a branch build with its own `pages: write`
permission and requires successful completion for the exact generated commit.
The site job can be retried independently after release publication. Ordinary
main site changes use native Woodpecker
Pages, with approved release ID/tag metadata prepared in a separate authenticated
step. The renderer and validators receive public metadata only. Local validation
may resolve a public tag without REST credentials, but that tag-only result cannot
authorize a Pages push. This hosted release-time refresh remains an explicit migration exception;
no release has been created to test the cutover.

## Cutover rollback

Before clearing `WOODPECKER_PUBLISHING`, stop new protected-main/tag publication
triggers and cancel or drain every active native publisher and hosted signing,
image-promotion and release-Pages bridge. Confirm that no job or queued dispatch
can still promote images, finalize a release or push Pages. Only then select and
read back the `.woodpecker-validation/` discovery profile, then clear the flag and
restore the prior required checks and Pages settings. This order prevents an
in-flight native bridge from publishing after the legacy owner resumes. Preserve
immutable versions and digests; inspect pending drafts and receipts before any
retry. Ordinary failed validation PR checks do not require publication
credentials or flag changes.

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

Create a signed annotated tag at the verified `origin/main` commit and push only
that tag:

```bash
version="$(node -p "require('./package.json').version")"
git tag -s "v${version}" -m "uDDNS v${version}"
git push origin "v${version}"
```

Do not move or reuse a published release tag. The active release owner rejects
tags that do not match `package.json` and retains the same signed source.

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

3. Confirm the exact-version container tag resolves. A newer stable release
   advances its minor and `latest`; a backport advances only its applicable minor
   and never downgrades global `latest`:

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

## Retiring duplicate portable Linux validation

Both repository variables `WOODPECKER_LINUX_CI=true` and
`WOODPECKER_PUBLISHING=true` are required to retire the duplicate portable Linux
jobs. Keep `WOODPECKER_LINUX_CI` absent or false until exact PR and merged-main
native checks pass, the broker and publishing owner are accepted, and required
checks migrate to the tested native contexts. The publishing flag follows its
separate coordinated owner cutover; it can be enabled first while duplicate Linux
validation remains active. Publication rollback restores these hosted checks when its flag
is cleared; cancel or drain active publishers before changing that owner flag.
Native macOS, actual Docker/runtime/devcontainer validation, and metadata/update
automation remain hosted. The separate default-off `WOODPECKER_NIX_CI` flag controls
only the duplicate hosted Linux `devenv test` step after exact native PR and
genuine merged-main parity proof; see [development environments](development-environments.md). The validation flag does not authorize credentials or publication.

This repository has no legacy weekly application-validation schedule to retire.
Its Thursday Spec Kit updater and daily maintainer-assignment schedules remain.
The hosted CI change planner, supply-chain pin metadata, runtime-image job and CI
result aggregator remain active so selected Docker fixture failures still block
integration. Preserve the required supply-chain, CI result and development
contexts alongside the tested native check when migrating protections.

### Workflow discovery profiles

Keep Woodpecker's repository `config_file` set to `.woodpecker-validation/`
while publishing is disabled, including on Gitea mirrors. This directory is a
byte-for-byte generated validation allowlist; matching basenames retain required
check identities. Canonical validation lives in `.woodpecker/`. Run
`python3 scripts/ci/sync-woodpecker-validation.py --write` after editing it;
`--check` fails on drift, missing files or extra discovered workflows. Never add
publishers to the validation profile. The check runs in both discovery profiles.

For publication cutover, first drain the legacy publisher and all queued hosted
publication bridges. Read back the prior discovery and cancellation settings.
Remove only `push` from Woodpecker `cancel_previous_pipeline_events`, preserving
PR cancellation and every unrelated event, so a later main push cannot cancel a
data-changing publisher. Enable GitHub's `WOODPECKER_PUBLISHING=true`, then select
Woodpecker `config_file=.woodpecker/`. Read back all three controls in order. The selection is an independent operator
control, not a credential grant; the broker still enforces the GitHub flag and
exact protected source. Wrong or unavailable credentials fail closed. Do not run
the full profile with publishing disabled: unresolved secret references fail at
compilation, before helper commands run.

For rollback, stop new publication triggers and cancel or drain every native and
hosted publisher first. Switch Woodpecker to `.woodpecker-validation/` before
clearing the GitHub publishing flag and restoring legacy publishing. Verify both
readbacks; only after the drain may validation-only mode restore the previous
push-cancellation setting if desired. Queued or
restarted pipelines may retain stored workflow configurations, so cancel those
explicitly; changing discovery does not sanitize an existing pipeline. Keep the
Linux retirement flag off until its separate acceptance requirements are met.

Profile changes apply to newly created pipelines. Select the full profile before
merging the reviewed branch so its genuine main push tests validation and delivery
in one pipeline. A new manual run can prove validation-only discovery; it cannot
start publication. Restart reuses saved definitions and cannot activate a changed
profile or sanitize an old publisher configuration.
