# uddns devcontainer

Open this repository in VS Code and run **Dev Containers: Reopen in
Container**. A local Docker-compatible engine and the Dev Containers extension
are required. The first build downloads the pinned tool images and distribution
packages. Setup installs dependencies from this checkout's lockfiles and runs
`smoke.sh`. Rebuild the container after Dockerfile changes. Rerun
`bash .devcontainer/post-create.sh` after changing dependency lockfiles.

Node follows this copy's package manifest. Installs the exact pnpm version and
locked dependencies. Run `pnpm run verify` for the full gate. Provider tests
use mocks. Opening the container does not start the updater or perform DNS
writes.

Run from the workspace root:

```sh
pnpm exec vp check && pnpm run docs:check
```

The editor runs as `vscode`, with its UID adjusted for the local workspace. The
source is bind-mounted at `/workspace` and is never copied into image layers.
Use a regular clone when the container cannot see a linked worktree's external
Git directory. Keep credentials in your local development environment.

`bash .devcontainer/smoke.sh` checks installed tools and checkout access. It
does not run the application test suite. No application starts automatically.
Image references include immutable digests. Dependabot monitors the Dockerfiles
where supported. Distribution packages resolve from the configured Debian
repositories at build time. Update image pins and rerun setup and native checks
together. Existing native and Nix workflows remain available independently.

Choose **uDDNS with Docker** for `docker build` and container integration work.
That profile runs the official Docker-in-Docker feature with its own daemon.
The default profile includes the Docker CLI and Compose. Nested Docker needs
an engine capable of privileged Docker-in-Docker; this host's rootless Podman
cannot provide the required legacy iptables NAT table.
