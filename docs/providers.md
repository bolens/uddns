# Providers and configuration

`.env.example` is the complete environment-variable reference. This guide
describes host behavior and the provider-specific values needed to get started.

Set `UDDNS_PROVIDER` to one of: `cloudflare` (default), `duckdns`, `noip`,
`dynu`, `namecheap`, `dyndns`.

## Multiple hosts and checkpoints

Update several names on one provider/account:

```env
UDDNS_HOSTS=home.example.com,vpn.example.com,api.example.com
```

`UDDNS_HOST` remains available for one host. Each host is checkpointed
independently, so a partial failure retries only failed hosts. Checkpoints
default to `.uddns-state.json`; set `UDDNS_STATE_FILE=` to keep state in memory.

Transient transport errors, HTTP 429, and HTTP 5xx responses retry three times
with exponential, jittered backoff.

## Cloudflare

Create an API token with **Zone → DNS → Edit** and add **Zone → Zone → Read**
when resolving zones by name.

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
# CLOUDFLARE_RECORD_ID=record_id
```

When `CLOUDFLARE_ZONE_ID` is absent, uDDNS tries
`CLOUDFLARE_ZONE_NAME`, then walks parent domains for each host. Existing A/AAAA
records are patched. Missing records are created when
`CLOUDFLARE_CREATE_IF_MISSING=true`.

## DuckDNS

```env
UDDNS_PROVIDER=duckdns
DUCKDNS_TOKEN=your_token
UDDNS_HOSTS=myhost,otherhost
# Or: DUCKDNS_DOMAINS=myhost,otherhost
```

## No-IP

```env
UDDNS_PROVIDER=noip
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.ddns.net,other.ddns.net
```

## Dynu

```env
UDDNS_PROVIDER=dynu
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.dynu.com,other.dynu.com
```

## Namecheap

Use the Dynamic DNS password, not the account password.

```env
UDDNS_PROVIDER=namecheap
NAMECHEAP_DOMAIN=example.com
NAMECHEAP_PASSWORD=your_ddns_password
UDDNS_HOSTS=home,vpn,api
```

FQDN values such as `home.example.com` are also accepted in `UDDNS_HOSTS`.

## DynDNS-compatible

Generic `/nic/update` clients, including Dyn.com-compatible services:

```env
UDDNS_PROVIDER=dyndns
UDDNS_USER=your_username
UDDNS_PASS=your_password
UDDNS_HOSTS=myhost.example.com,other.example.com
# Optional; credentials require HTTPS:
# DYNDNS_UPDATE_URL=https://members.dyndns.org/nic/update
```
