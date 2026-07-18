# uDDNS

Micro multi-provider Dynamic DNS updater. Defaults to **Cloudflare**, and also supports DuckDNS, No-IP, Dynu, Namecheap, Route53, Porkbun, Hetzner, DigitalOcean, and generic DynDNS-compatible endpoints.

Checks your public IP on an interval and updates DNS only when it changes. Recommended interval: `900000` (15 minutes).

One process manages one provider/account by default. Use `UDDNS_CONFIG_FILE` for
multi-account YAML, or run separate processes (with separate `.env` and state
files) when you prefer isolation.

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

CLI helpers after build:

```bash
node dist/cli.js init --defaults
node dist/cli.js once --dry-run
node dist/cli.js once --force
node dist/cli.js check-config
```

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
Set `UDDNS_LOG_FORMAT` to `text` (default) or `json`.

- Timestamps include seconds
- Failures include HTTP status/timing, sanitized URLs, response previews, and hints
- Secrets (tokens, passwords, `Authorization`) are redacted from log context
- Use `debug` when chasing provider/API issues

### Public IP discovery

Public addresses are discovered without a third-party IP package: HTTPS echo services first (icanhazip, ipify, ifconfig.co — TLS authenticates the answer). Optional DNS fallbacks (OpenDNS `myip.opendns.com`, then Google `o-o.myaddr.l.google.com` TXT) are **off by default** because plain DNS can be spoofed on-path; enable with `UDDNS_IP_DNS_FALLBACK=true` only on networks where HTTPS echo is unreachable and you trust the DNS path. Override endpoints with `UDDNS_IP_HTTPS_V4` / `UDDNS_IP_HTTPS_V6`.

## Configuration

Copy `.env.example`, choose one provider/account, and configure one or more
hosts. The default interval is `900000` ms and checkpoints persist in
`.uddns-state.json`.

See [Providers and configuration](docs/providers.md) for provider-specific
examples. For multiple accounts in one process, set `UDDNS_CONFIG_FILE` to a
YAML file (see `examples/uddns.multi.yaml`).
