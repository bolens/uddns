# Portable CI and controlled publication

## Scope

Move practical GNU/Linux validation and publishing from GitHub Actions to direct
GitHub-connected Woodpecker, retaining existing destinations and verified artifact
identities. Gitea copies validate only. Preserve native macOS and GitHub OIDC
signing/attestation where their platform identity is required. This specification
precedes this migration; earlier CI enablement remains retained history.

## Acceptance criteria

1. Native commands retain current tests, runtime floors, dependency pins, coverage
   thresholds and skip reporting. Docker lifecycle checks remain required until
   an isolated builder/runtime demonstrates equivalent fixture/ownership safety.
2. GitHub canonical exact SHA is the source identity. Main/tag publication requires
   server-authenticated forge/repository/ref/SHA authorization; no PR/manual/fork
   credential access, local secret fallback, Docker socket or privileged builds.
3. A tested immutable image digest is the artifact identity. Version collisions
   fail closed; aliases advance only after verification and cannot regress.
4. GitHub OIDC bridges accurately attest the external builder and verify the
   complete exact-source receipt before signing. Public verification contracts
   remain true. No release tag/version is created during migration tests.
5. Pages, where present, validates its rendered site and publishes one serialized
   gh-pages branch owner with .nojekyll. No duplicate Actions deploy trigger.
6. Existing Actions gates remain active until native exact-head acceptance and
   owning required-check/settings migration are proven.
