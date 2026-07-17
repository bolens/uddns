# uDDNS

Micro multi-provider Dynamic DNS updater. Defaults to **Cloudflare**, and also supports DuckDNS, No-IP, Dynu, Namecheap, and generic DynDNS-compatible endpoints.

Checks your public IP on an interval and updates DNS only when it changes. Recommended interval: `900000` (15 minutes).

One process manages one provider/account. Run separate processes (with separate `.env` and
state files) when you need to update multiple providers.

## Requirements

- [Vite+](https://viteplus.dev/) (`vp`)
- Node.js (managed by Vite+ / Corepack)
- pnpm via Corepack (`packageManager` in `package.json`)

## Install

```bash
corepack enable
vp install
```

Or open the repo in a [Dev Container](https://containers.dev/) (VS Code "Reopen in
Container" or `devcontainer up`): `.devcontainer/` provisions Node 24, pnpm, the Vite+
toolchain, and Docker, then installs dependencies automatically.

## Run

```bash
vp run build
vp run start
```

`start` loads `.env` via Node's `--env-file-if-exists=.env` (no dotenv package)
and runs the core updater daemon.

Configuration is validated before any network request. After building, validate and exit:

```bash
vp run config:check
```

## Documentation

- [Providers and configuration](docs/providers.md)
- [Optional MCP server](docs/mcp.md)
- [Deployment with systemd, Docker, or Compose](docs/deployment.md)
- [Development, architecture, and adding providers](docs/development.md)

### Logging

Set `UDDNS_LOG_LEVEL` to `error`, `warn`, `info` (default), or `debug`.

- Timestamps include seconds
- Failures include HTTP status/timing, sanitized URLs, response previews, and hints
- Secrets (tokens, passwords, `Authorization`) are redacted from log context
- Use `debug` when chasing provider/API issues

### Public IP discovery

Public addresses are discovered without a third-party IP package: HTTPS echo services first (icanhazip, ipify, ifconfig.co — TLS authenticates the answer), with DNS fallbacks (OpenDNS `myip.opendns.com`, then Google `o-o.myaddr.l.google.com` TXT) for networks where the HTTPS services are unreachable. The plain-DNS fallback can be spoofed by an on-path attacker; restrict outbound DNS or disable it in a hardened deployment.

## Configuration

Copy `.env.example`, choose one provider/account, and configure one or more
hosts. The default interval is `900000` ms and checkpoints persist in
`.uddns-state.json`.

See [Providers and configuration](docs/providers.md) for provider-specific
examples. Run separate processes with separate environment and state files when
updating multiple provider accounts.
