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
