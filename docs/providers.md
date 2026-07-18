# Providers and configuration

`.env.example` is the complete environment-variable reference. This guide
describes host behavior and the provider-specific values needed to get started.

Set `UDDNS_PROVIDER` to one of: `cloudflare` (default), `duckdns`, `noip`,
`dynu`, `namecheap`, `dyndns`, `route53`, `porkbun`, `hetzner`,
`digitalocean`, `gandi`, `linode`, `ovh`, `bunny`, `contabo`.

## Multiple hosts and checkpoints

Update several names on one provider/account:

```env
UDDNS_HOSTS=home.example.com,vpn.example.com,api.example.com
# Pause a host without removing it:
# UDDNS_DISABLED_HOSTS=vpn.example.com
```

`UDDNS_HOST` remains available for one host. Each host is checkpointed
independently, so a partial failure retries only failed hosts. Checkpoints
default to `.uddns-state.json`; set `UDDNS_STATE_FILE=` to keep state in memory.
Disabled hosts are skipped and cannot be force-updated.

`UDDNS_INTERVAL` defaults to `900000` ms (15 minutes) and must be between
`60000` and `86400000` ms (60 s–24 h). Absolute state/history paths can
be jailed under `UDDNS_DATA_DIR` when set.

## Public IP policy

`UDDNS_IP_FAMILY` selects `dual` (default), `v4`, or `v6`.
`UDDNS_IP_MISSING=keep` (default) reuses the previous address when discovery
fails for a family. `clear` omits that family from the next upsert so providers
do not rewrite it — it does **not** delete existing A/AAAA records at the DNS
provider.

HTTPS echo discovery uses pin-on-connect (resolve once, dial only verified
public addresses). DNS fallbacks stay off unless `UDDNS_IP_DNS_FALLBACK=true`.
See [Security](security.md).

Transient transport errors, HTTP 429, and HTTP 5xx responses retry three times
with exponential, jittered backoff. When a provider response includes
`Retry-After`, that delay is honored (capped by the max retry delay).

## Notifications

Optional HTTPS notifications after cycles:

```env
# UDDNS_NOTIFY_WEBHOOK_URL=https://example.com/hook
# UDDNS_NOTIFY_NTFY_URL=https://ntfy.sh/my-topic   # LAN ntfy allowed
# UDDNS_NOTIFY_SLACK_URL=https://hooks.slack.com/services/...
# UDDNS_NOTIFY_DISCORD_URL=https://discord.com/api/webhooks/...
# UDDNS_NOTIFY_ON=change,error
```

Webhook/ntfy may target private LAN hosts; Slack/Discord may not. Loopback and
cloud-metadata targets are always rejected.

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
# Optional; credentials require HTTPS and an allowlisted host:
# DYNDNS_UPDATE_URL=https://members.dyndns.org/nic/update
# Extra hosts beyond the built-in allowlist (comma-separated):
# DYNDNS_UPDATE_URL_ALLOW_HOSTS=ddns.example.net
```

Built-in allowlist hosts: `members.dyndns.org`, `members.dyndns.com`,
`update.dyndns.org`, `dynupdate.no-ip.com`, `dynupdate.no-ip.org`. See
[Security](security.md).

## AWS Route53

Use an IAM user (or key pair) limited to `route53:ChangeResourceRecordSets`
and `route53:ListResourceRecordSets` on the hosted zone. Records are
UPSERTed via the Route53 REST API with SigV4 signing — no AWS SDK required.

```env
UDDNS_PROVIDER=route53
ROUTE53_ACCESS_KEY_ID=AKIA...
ROUTE53_SECRET_ACCESS_KEY=your_secret_key
ROUTE53_HOSTED_ZONE_ID=Z1234567890ABC
UDDNS_HOSTS=home.example.com,vpn.example.com

# Optional:
# ROUTE53_REGION=us-east-1
# ROUTE53_TTL=300
# ROUTE53_CREATE_IF_MISSING=true
```

## Porkbun

Create an API key pair under Account → API Access and enable API access for
the domain.

```env
UDDNS_PROVIDER=porkbun
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_KEY=sk1_...
PORKBUN_DOMAIN=example.com
UDDNS_HOSTS=home,vpn
```

FQDN values such as `home.example.com` are also accepted in `UDDNS_HOSTS`;
without `PORKBUN_DOMAIN` the registered domain is assumed to be the last two
labels of each host.

## Hetzner DNS

Create an API token in the Hetzner DNS console.

```env
UDDNS_PROVIDER=hetzner
HETZNER_API_TOKEN=your_api_token
# One of (otherwise parent domains of each host are tried):
HETZNER_ZONE_ID=your_zone_id
# HETZNER_ZONE_NAME=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
```

## DigitalOcean

Create a personal access token with `domain` read/write scope.

```env
UDDNS_PROVIDER=digitalocean
DIGITALOCEAN_API_TOKEN=dop_v1_...
DIGITALOCEAN_DOMAIN=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
```

Without `DIGITALOCEAN_DOMAIN` the registered domain is assumed to be the last
two labels of each host.

## Gandi LiveDNS

Use a Personal Access Token with domain technical-configuration rights.

```env
UDDNS_PROVIDER=gandi
GANDI_API_TOKEN=your_pat
GANDI_DOMAIN=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
# Optional: GANDI_TTL=300
```

## Akamai Connected Cloud (Linode DNS)

Create a personal access token with Domains read/write scope.

```env
UDDNS_PROVIDER=linode
LINODE_API_TOKEN=your_token
LINODE_DOMAIN_ID=12345
LINODE_DOMAIN=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
# Optional: LINODE_TTL=300
```

## OVHcloud

Create an application key, secret, and consumer key with DNS zone record
CRUD plus refresh rights. Endpoint is one of `eu`, `ca`, or `us`.

```env
UDDNS_PROVIDER=ovh
OVH_ENDPOINT=eu
OVH_APPLICATION_KEY=...
OVH_APPLICATION_SECRET=...
OVH_CONSUMER_KEY=...
OVH_ZONE=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
# Optional: OVH_TTL=300
```

## bunny.net DNS

Use the account API key from the bunny.net dashboard.

```env
UDDNS_PROVIDER=bunny
BUNNY_API_KEY=your_access_key
BUNNY_ZONE_ID=12345
BUNNY_DOMAIN=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
# Optional: BUNNY_TTL=300
```

## Contabo DNS

Create OAuth client credentials and an API user in the Contabo control panel.

```env
UDDNS_PROVIDER=contabo
CONTABO_CLIENT_ID=...
CONTABO_CLIENT_SECRET=...
CONTABO_API_USER=you@example.com
CONTABO_API_PASSWORD=...
CONTABO_ZONE=example.com
UDDNS_HOSTS=home.example.com,vpn.example.com
# Optional: CONTABO_TTL=300
```
