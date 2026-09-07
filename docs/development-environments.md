# Development environments

[Documentation](README.md)

Install [devenv](https://devenv.sh/getting-started/) and run `devenv shell`.
The lockfile pins the Nix toolchain, including Node 26.7.0. The Corepack pnpm
wrapper honors the repository's `packageManager` version (11.24.0).
Run `devenv test` or `repo-check` inside the shell. The initial install skips lifecycle scripts; hook installation and live-provider
tests are disabled throughout verification. The wrapper runs
the existing sharded verification, site source checks, and adapter/workflow lint.
It does not start the updater or perform DNS writes.

## Local containers

```sh
python3 scripts/development-container.py build docker
python3 scripts/development-container.py run docker -- bash scripts/check-development.sh
python3 scripts/development-container.py build podman
python3 scripts/development-container.py run podman -- bash scripts/check-development.sh
```

Images contain development tools, with source mounted only when running. Images
and archives remain local; the adapter does not publish them. Runtime commands
preserve the caller UID/GID and Podman's user namespace. Do not mount credentials
or enable live tests. Dependency installation needs network access; provider
verification uses fixtures. Keep production deployment separate from this shell.

On a supported Apple Silicon Mac, use `apple` in place of `docker`; this invokes
Apple's `container` CLI. Building Linux images from macOS requires a configured
Linux Nix builder. Native macOS and Apple container execution have separate
validation requirements; Apple execution has not been verified from Linux.

## Validation and delivery

The environment CI selects affected work with path filters, runs Linux/macOS
native checks and Docker independently, cancels superseded runs, and reports an
always-running result. Native Linux and actual rootless Podman checks passed 484 application tests and
five adapter tests, plus coverage, build, dead-code, site source and workflow
checks. Native macOS and hosted Docker validation remain pending. The pre-push responsive site gate additionally requires a host Chrome
or Chromium; follow [development](development.md) and [release guidance](../RELEASING.md).
No DNS service or background process is configured by devenv.

The Linux image includes the standard ELF loader path and GCC runtime libraries
required by pnpm’s downloaded Node binary. These paths exist only inside the image.
Native and container installs can relink `node_modules`; rerun `repo-check` when
switching between them.
