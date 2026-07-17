# Providers and configuration

`.env.example` is the complete environment-variable reference. This guide
describes host behavior and the provider-specific values needed to get started.

Set `UDDNS_PROVIDER` to one of: `cloudflare` (default), `duckdns`, `noip`,
`dynu`, `namecheap`, `dyndns`, `route53`, `porkbun`, `hetzner`,
`digitalocean`.

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
