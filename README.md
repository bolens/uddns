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

`start` loads `.env` via Node's `--env-file-if-exists=.env` (no dotenv package).

Configuration is validated before any network request. After building, validate and exit:

```bash
vp run config:check
```

### Logging

Set `UDDNS_LOG_LEVEL` to `error`, `warn`, `info` (default), or `debug`.

- Timestamps include seconds
- Failures include HTTP status/timing, sanitized URLs, response previews, and hints
- Secrets (tokens, passwords, `Authorization`) are redacted from log context
- Use `debug` when chasing provider/API issues

### Public IP discovery

Public addresses are discovered without a third-party IP package: HTTPS echo services first (icanhazip, ipify, ifconfig.co — TLS authenticates the answer), with DNS fallbacks (OpenDNS `myip.opendns.com`, then Google `o-o.myaddr.l.google.com` TXT) for networks where the HTTPS services are unreachable. The plain-DNS fallback can be spoofed by an on-path attacker; restrict outbound DNS or disable it in a hardened deployment.

## Providers

Set `UDDNS_PROVIDER` to one of: `cloudflare` (default), `duckdns`, `noip`, `dynu`, `namecheap`, `dyndns`.

### Multiple hosts

Update several names on the same provider/account with one process:

```env
UDDNS_HOSTS=home.example.com,vpn.example.com,api.example.com
```

`UDDNS_HOST` still works for a single name. Each host is checkpointed independently, so a
partial failure retries only failed hosts rather than repeatedly updating successful ones.
Checkpoints default to `.uddns-state.json`; set `UDDNS_STATE_FILE=` to keep state in memory only.
Transient transport, HTTP 429, and HTTP 5xx failures retry three times with exponential,
jittered backoff.

### Cloudflare (default)

Create an API token with **Zone → DNS → Edit** (and Zone → Zone → Read if you resolve zones by name).

```env
UDDNS_PROVIDER=cloudflare
UDDNS_INTERVAL=900000
UDDNS_HOSTS=home.example.com,vpn.example.com

CLOUDFLARE_API_TOKEN=your_api_token
# One of:
CLOUDFLARE_ZONE_ID=your_zone_id
# CLOUDFLARE_ZONE_NAME=example.com

# Optional:
# CLOUDFLARE_PROXIED=false
# CLOUDFLARE_TTL=1
# CLOUDFLARE_CREATE_IF_MISSING=true
# CLOUDFLARE_RECORD_ID=...   # single-host only
```

If `CLOUDFLARE_ZONE_ID` is omitted, the updater tries `CLOUDFLARE_ZONE_NAME`, then walks parents of each host to find the zone. Existing A/AAAA records are patched; missing records are created when `CLOUDFLARE_CREATE_IF_MISSING=true`.

### DuckDNS

```env
UDDNS_PROVIDER=duckdns
DUCKDNS_TOKEN=your_token
UDDNS_HOSTS=myhost,otherhost
# or: DUCKDNS_DOMAINS=myhost,otherhost
```

### No-IP

```env
UDDNS_PROVIDER=noip
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.ddns.net,other.ddns.net
```

### Dynu

```env
UDDNS_PROVIDER=dynu
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.dynu.com,other.dynu.com
```

### Namecheap

Use the Dynamic DNS password from Namecheap (not your account password).

```env
UDDNS_PROVIDER=namecheap
NAMECHEAP_DOMAIN=example.com
NAMECHEAP_PASSWORD=your_ddns_password
UDDNS_HOSTS=home,vpn,api
# or FQDNs: UDDNS_HOSTS=home.example.com,vpn.example.com
```

### DynDNS-compatible

Generic `/nic/update` clients (Dyn.com and similar).

```env
UDDNS_PROVIDER=dyndns
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.example.com,other.example.com
# Optional custom endpoint (must be https:// — credentials are sent with the request):
# DYNDNS_UPDATE_URL=https://members.dyndns.org/nic/update
```

## Develop

```bash
vp check              # format + type-aware lint + types
vp fmt --write        # format in place
vp lint               # oxlint
vp test               # deterministic unit + docs contract tests
vp run test:live      # opt-in real HTTP check against Dyn's test account
vp staged             # run checks on staged files
vp config             # install Vite+ git hooks (skip with VITE_GIT_HOOKS=0)
vp run docs:check     # focused documentation-drift check
vp run lean:check     # Fallow dead-code/dependency check
vp run build          # emit dist/
vp run config:check   # validate .env after building, then exit
vp run verify         # check + test + build + lean
```

### Keeping code and docs lean

- `README.md` is the user guide; `.env.example` is the complete configuration reference. Avoid duplicating either in a separate docs tree.
- Documentation contract tests keep the provider list, accepted environment variables, and documented package commands synchronized with code.
- Fallow rejects unused files, exports, and dependencies. Run `vp run verify` before committing.
- When configuration, providers, or commands change, update their canonical documentation in the same change.

## Architecture

```
app.ts                 # thin entrypoint (config → provider → updater loop)
lib/
  config.ts            # re-exports loadConfig
  hosts.ts             # multi-host parse/bind helpers
  ip.ts                # DNS + HTTPS public IP discovery
  log.ts               # timestamped logger
  result.ts            # ok / fail / skipped helpers
  updater.ts           # check/update orchestration (testable, multi-host loop)
  schemas/             # Zod schemas + inferred types
  providers/
    index.ts           # registry
    http.ts            # fetch helpers + HttpError
    nic-update.ts      # shared DynDNS /nic/update client
    cloudflare.ts      # Cloudflare API provider
    ...                # one file per provider
tests/
  helpers/             # shared fixtures (makeConfig, stubFetch)
  *.test.ts            # config / ip / updater
  providers/           # mocked unit suites per provider + registry + nic-update
  live/                # real HTTP against provider test endpoints (Dyn only today)
```

Provider HTTP suites mock `fetch` by default, so `vp test` and CI are deterministic. Dyn is the only bundled provider that publishes a public client-development test account ([test account docs](https://help.dyn.com/test-account.html)); run `vp run test:live` explicitly to execute `tests/live/dyndns.test.ts`. Other providers have no DDNS sandbox, so they stay mocked.

## Run as a service

Build first, then use a supervisor so fatal errors restart the daemon. The process handles
`SIGINT`/`SIGTERM`, stops scheduling work, waits for the active update cycle, and exits.

Example systemd unit:

```ini
[Unit]
Description=uDDNS updater
After=network-online.target

[Service]
WorkingDirectory=/opt/uddns
EnvironmentFile=/opt/uddns/.env
ExecStart=/usr/bin/node /opt/uddns/dist/app.js
Restart=on-failure
User=uddns

[Install]
WantedBy=multi-user.target
```

The included multi-stage `Dockerfile` builds the app and runs it as an unprivileged user:

```bash
docker build -t uddns .
docker run -d --name uddns --restart unless-stopped \
  --env-file .env \
  -v uddns-state:/data \
  uddns
```

### Compose (Docker / Podman)

`compose.yml` builds the image, loads `.env`, and persists checkpoints in a named volume.
Works with `docker compose` and `podman-compose`:

```bash
cp .env.example .env   # then edit .env
docker compose up -d   # or: podman-compose up -d
docker compose logs -f
```

### Adding a provider

1. Create `lib/providers/<id>.ts` exporting a `Provider` (`id`, `label`, `update`)
2. Register it in `lib/providers/index.ts` and `PROVIDER_IDS` in `lib/schemas/provider.ts`
3. Map env vars in `lib/schemas/config.ts`
4. Add `tests/providers/<id>.test.ts` (and a `tests/live/` suite only if the provider publishes a real test/sandbox DDNS API)
5. Document env vars in this README and `.env.example`

Prefer returning `fail("...")` for validation errors instead of throwing, so the loop keeps running.
