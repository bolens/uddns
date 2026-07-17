# uDDNS

Micro multi-provider Dynamic DNS updater. Defaults to **Cloudflare**, and also supports DuckDNS, No-IP, Dynu, Namecheap, and generic DynDNS-compatible endpoints.

Checks your public IP on an interval and updates DNS only when it changes. Recommended interval: `900000` (15 minutes).

## Requirements

- [Vite+](https://viteplus.dev/) (`vp`)
- Node.js (managed by Vite+ / Corepack)
- pnpm via Corepack (`packageManager` in `package.json`)

## Install

```bash
corepack enable
vp install
```

## Run

```bash
vp run build
vp run start
```

`start` loads `.env` via Node's `--env-file-if-exists=.env` (no dotenv package).

### Logging

Set `UDDNS_LOG_LEVEL` to `error`, `warn`, `info` (default), or `debug`.

- Timestamps include seconds
- Failures include HTTP status/timing, sanitized URLs, response previews, and hints
- Secrets (tokens, passwords, `Authorization`) are redacted from log context
- Use `debug` when chasing provider/API issues

### Public IP discovery

Public addresses are discovered without a third-party IP package: DNS first (OpenDNS `myip.opendns.com`, then Google `o-o.myaddr.l.google.com` TXT), with HTTPS echo fallbacks (icanhazip, ipify, ifconfig.co).

## Providers

Set `UDDNS_PROVIDER` to one of: `cloudflare` (default), `duckdns`, `noip`, `dynu`, `namecheap`, `dyndns`.

### Multiple hosts

Update several names on the same provider/account with one process:

```env
UDDNS_HOSTS=home.example.com,vpn.example.com,api.example.com
```

`UDDNS_HOST` still works for a single name. Each host is updated independently; the remembered public IP only advances when **all** hosts succeed (so partial failures retry next cycle).

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
# Optional custom endpoint:
# DYNDNS_UPDATE_URL=https://members.dyndns.org/nic/update
```

## Develop

```bash
vp check              # format + type-aware lint + types
vp fmt --write        # format in place
vp lint               # oxlint
vp test               # unit tests, including documentation contracts
vp staged             # run checks on staged files
vp config             # install Vite+ git hooks (skip with VITE_GIT_HOOKS=0)
vp run docs:check     # focused documentation-drift check
vp run lean:check     # Fallow dead-code/dependency check
vp run build          # emit dist/
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
  providers/           # one suite per provider + registry + nic-update
```

### Adding a provider

1. Create `lib/providers/<id>.ts` exporting a `Provider` (`id`, `label`, `update`)
2. Register it in `lib/providers/index.ts` and `PROVIDER_IDS` in `lib/schemas/provider.ts`
3. Map env vars in `lib/schemas/config.ts`
4. Add `tests/providers/<id>.test.ts`
5. Document env vars in this README and `.env.example`

Prefer returning `fail("...")` for validation errors instead of throwing, so the loop keeps running.
