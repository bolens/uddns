# Security

uDDNS treats outbound HTTPS and local control planes as untrusted surfaces.
This page summarizes the built-in safeguards. `.env.example` remains the
complete environment-variable reference.

## Outbound HTTPS (pin-on-connect)

Provider API calls, public-IP echo requests, and notification webhooks dial
HTTPS with **pin-on-connect**:

1. Resolve the hostname.
2. Reject loopback, link-local, cloud-metadata, and (by default) private
   addresses — including IPv4-mapped IPv6 and nip.io / sslip.io style embeds.
3. Connect only to the verified address set (no second DNS lookup between
   check and TCP), which closes classic DNS-rebinding races.

Redirects never leave HTTPS and never change host when credentials or trusted
echo answers are involved.

## Notification URL policy

| Channel         | Private LAN hosts | Loopback / metadata |
| --------------- | ----------------- | ------------------- |
| Webhook / ntfy  | Allowed           | Always blocked      |
| Slack / Discord | Blocked           | Always blocked      |

All notification URLs must be `https://` without embedded userinfo.

## DynDNS update URL allowlist

`DYNDNS_UPDATE_URL` must be HTTPS and its hostname must appear on an allowlist.
Built-in hosts:

- `members.dyndns.org`
- `members.dyndns.com`
- `update.dyndns.org`
- `dynupdate.no-ip.com`
- `dynupdate.no-ip.org`

Extend with `DYNDNS_UPDATE_URL_ALLOW_HOSTS` (comma-separated).

## Public IP discovery

HTTPS echo endpoints are preferred because TLS authenticates the answer.
Optional DNS fallbacks (`UDDNS_IP_DNS_FALLBACK=true`) are off by default —
plain DNS can be forged on-path. Custom `UDDNS_IP_HTTPS_V4` /
`UDDNS_IP_HTTPS_V6` endpoints must be HTTPS and are resolved under the same
host-safety rules before connect.

## Control-plane authentication

### Health / metrics side server

When `UDDNS_HEALTH=1`:

- **Loopback** still requires `UDDNS_HEALTH_AUTH_TOKEN` unless
  `UDDNS_HEALTH_ALLOW_INSECURE_LOOPBACK=true`.
- **Non-loopback** requires the auth token plus TLS cert/key.
- With auth configured, `/metrics` and `/events` require the bearer token;
  `/healthz` and `/readyz` stay open for probes.

### MCP HTTP

Same pattern: loopback requires `UDDNS_MCP_AUTH_TOKEN` unless
`UDDNS_MCP_ALLOW_INSECURE_LOOPBACK=true`. Non-loopback requires token + TLS.
Live destructive MCP tools (`check_once`, `force_update`, `update_hosts`,
`start_loop`) also require `confirm: true`.

## Paths and intervals

- Absolute `UDDNS_STATE_FILE` / `UDDNS_HISTORY_FILE` paths must stay under
  `UDDNS_DATA_DIR` when that root is set (path jail).
- Check intervals are clamped to `60000`–`86400000` ms (60 s–24 h) for
  `UDDNS_INTERVAL` and MCP `set_interval`.

## Logging

Tokens, passwords, `Authorization` headers, usernames, and OAuth client IDs
are redacted from log context and history messages. Prefer provider-specific
env vars over putting secrets in URLs.
