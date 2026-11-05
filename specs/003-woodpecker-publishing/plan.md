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
keeps activation disabled. The broker is the security boundary, not YAML filters.

Ordinary socket-free Kaniko is a candidate for image builds. Its lack of BuildKit
max provenance/SBOM and inability to execute runtime fixtures remain explicit
migration gaps until an equivalent isolated builder/runtime is proven. Preserve
existing platform guarantees and do not claim execution from source inspection.

Validate shell/YAML/fleet contracts, mocked publication denial/identity behavior,
native application gates, then exact-source Woodpecker with no production release.
Migrate one owning trigger/status only after that evidence and root settings proof.
