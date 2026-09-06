# UDDNS development environments

Provide a locked native Linux/macOS shell and a source-free Linux image usable
with Docker, rootless Podman, and Apple container. Honor the repository's pinned
Node and pnpm versions and run the existing sharded, stubbed-provider verification
without starting the updater, reading live credentials, or writing DNS records.

The checkout is mounted only at run time. Preserve caller file ownership and
command argument boundaries. Report missing engines and unsupported Apple hosts
clearly. Apple execution requires supported Mac hardware and a Linux Nix builder;
record unavailable execution as unverified.

Acceptance requires native verification, actual container verification, adapter
regressions, and passing selected CI on the reviewed commit. Existing site visual
and release gates remain required through the repository playbook. Development
configuration changes alone do not require a product version or release tag.
