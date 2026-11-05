# Implementation plan

Use existing repository commands and immutable fleet validator revisions. Extend
credential-free Woodpecker validation first. Root owns the authenticated secret
broker, GitHub forge/OAuth registration, selected-repository App permissions,
GHCR service-account credentials, isolated builders and Pages/check settings.

Publishers consume github_publish_lease, ghcr_username and ghcr_password only
from the broker for approved metadata/images. The opaque GitHub lease is redeemed
at execution time at the fixed TLS broker endpoint; short-lived tokens remain
only in memory/subprocess environments and refresh below 120 seconds remaining.
Git trace/debug settings are removed from authenticated subprocesses. Repository variable
WOODPECKER_PUBLISHING must explicitly enable production delivery; its absence
keeps delivery disabled. Core, publisher and Pages configurations are staged in
discovery; coordinate broker/flag and branch Pages settings before owner cutover. The broker is the security boundary, not YAML filters.

Socket-free Kaniko builds the candidate and pinned Syft supplies native SPDX.
The native SLSA statement records the actual external builder. A thin hosted
Docker/OIDC bridge waits for the exact complete native pipeline, validates the
pulled digest offline, signs/attests without rebuilding, then promotes aliases
and publishes the owned draft. Native dispatch exits pending so the bridge does
not wait on an occupied runner. Release-time fresh-main Pages remains in that
hosted dependent job with explicit exact-commit branch build verification; ordinary
main Pages moves to Woodpecker. Platform/macOS, native
Nix/devenv and actual devcontainer exceptions remain until native parity proof.
No production release is created for migration validation.

Validate shell/YAML/fleet contracts, mocked publication denial/identity behavior,
native application gates, then exact-source Woodpecker with no production release.
Migrate one owning trigger/status only after that evidence and root settings proof.

Full-history cloning uses the installed plugin 2.11.0 pinned by digest, with
both depth zero and partial false. Partial cloning otherwise overrides depth;
core validation must prove the actual checkout is not shallow before historical
checks can move off their existing owner.

Wrap each existing duplicate hosted condition with the two-flag OR guard, keeping
its triggers, permissions and original condition. Publication cutover can happen
first while duplicate Linux validation stays active. Cancellation/draining before
publication rollback is required; clearing its flag restores duplicate validation.

Generate `.woodpecker-validation/` from the explicit canonical validation allowlist
and require its byte/drift check in core validation. The operator selects this
profile when publication is off, then drains owners, removes only push cancellation,
enables the GitHub flag and selects the full profile before the genuine merge push.
Rollback drains both native/hosted publishers before selecting validation-only and
clearing the flag. Restarts reuse stored definitions; only new pipelines discover
profile changes. Preserve PR cancellation and unrelated settings.

## Linux development-environment parity follow-up

Append the owning pinned `devenv test` command as a new Nix-image step within the
existing core workflow; keep all current basenames, dependencies and required
contexts. Use the already trusted public cache, one Nix build job/two cores and
bounded test workers. Regenerate the byte-identical validation profile. Retain
actual Docker, macOS and OIDC checks. A separate `WOODPECKER_NIX_CI` flag defaults
off and skips only the hosted Linux native test after exact PR and genuine main
proof. Root owns the flag; source delivery does not enable it.

### Managed Node in the direct Nix CI image

Actual native step545 at3114eea reached the Nix shell and frozen dependency
installation, then failed when the Vite+ shim selected the managed Node26.7.0
binary whose standard ELF interpreter was absent. Reuse the exported development
image's existing Nix-derived loader/library closure through an explicit CI-only
`enterTest` wrapper. Require Linux/amd64/root/Docker and the exact workspace,
refuse conflicting paths, and keep generic host `enterShell` unchanged. Preserve
the runtime/package-manager pins and frozen install, check the managed binary's
version, and run the complete existing `repo-check`. Root owns the bounded exact
container loader proof; native exact-head/full-gate acceptance follows before
any `WOODPECKER_NIX_CI` change.
