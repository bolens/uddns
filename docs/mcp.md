# Optional MCP server

The core uDDNS daemon runs with `vp run start` and does not require MCP. The
optional MCP entrypoint exposes the same updater capabilities over stdio or
Streamable HTTP.

Run either the core daemon or an MCP mode for a given environment/state file.
Do not run both against the same provider configuration at once, because both
processes can issue updates.

When `UDDNS_CONFIG_FILE` points at a multi-account YAML file, MCP loads every
account and exposes `list_accounts` plus optional `accountId` arguments on
account-scoped tools.

## Run modes

| Command           | Mode                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `vp run mcp:http` | HTTP MCP with the updater loop started automatically for every account                        |
| `vp run mcp`      | stdio MCP; loops remain stopped until `start_loop` (all accounts when `accountId` is omitted) |

Build before starting any mode:

```bash
vp run build
```

## Cursor over stdio

Add uDDNS to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "uddns": {
      "command": "node",
      "args": ["--env-file-if-exists=.env", "/absolute/path/to/uddns/dist/mcp.js"],
      "cwd": "/absolute/path/to/uddns"
    }
  }
}
```

stdio reserves stdout for MCP JSON-RPC. uDDNS routes all diagnostics to stderr
in this mode.

Agents should call `validate_config` and `dry_run` before `check_once`,
`force_update`, or `update_hosts`, and pass `confirm: true` on those live
tools (and on `start_loop`). Prefer scoped `update_hosts` over account-wide
updates. See `.cursor/rules/uddns-safe-operations.mdc`.

## Tools

Tool results include both JSON text `content` and `structuredContent`.

- `list_providers` — list supported Dynamic DNS providers
- `list_accounts` — list loaded MCP accounts
- `get_public_ip` — discover the current public IPv4 and IPv6 addresses
- `get_config` — return the active configuration with secrets redacted
- `check_once` — run one overlap-safe update cycle (`confirm: true` required)
- `force_update` — force updates for all hosts ignoring checkpoints (`confirm: true` required)
- `dry_run` — show which hosts would update without calling the provider
- `update_hosts` — force or dry-run only selected configured hosts (live updates need `confirm: true`)
- `get_status` — inspect loop, interval, cycle, IP, and host checkpoint state
- `get_history` — return recent cycle history
- `validate_config` — field-level configuration validation
- `explain_last_cycle` — summarize the last cycle with next steps
- `set_interval` — change the live interval (1000 ms–24 h; multi-account without `accountId` updates every account)
- `start_loop` — run an immediate check and start interval scheduling (`confirm: true`; all accounts when `accountId` is omitted)
- `stop_loop` — stop scheduling and wait for an active cycle (all accounts when `accountId` is omitted)
- `init_config` — elicit non-secret init values and return a `.env` template

Long-running update tools emit MCP progress notifications when the client
provides a `progressToken`.

## Prompts

- `setup_provider`
- `diagnose_update`
- `fix_config`

## Resources

- `uddns://config`
- `uddns://public-ip`
- `uddns://status`
- `uddns://history`

Clients can subscribe to resource updates. After `resources/subscribe`,
successful cycles notify subscribed `uddns://status` and/or `uddns://history`
URIs only.

## Streamable HTTP

The endpoint is `/mcp`. Defaults:

```env
UDDNS_MCP_TRANSPORT=http
UDDNS_MCP_HOST=127.0.0.1
UDDNS_MCP_PORT=3923
```

Operational endpoints:

- `GET /healthz` — liveness, without bearer auth
- `GET /readyz` — readiness probe (`{ ok }`), without bearer auth; returns 503
  until the updater has completed a successful cycle
- `GET /metrics` — Prometheus cycle/update/discovery metrics; requires bearer
  auth when `UDDNS_MCP_AUTH_TOKEN` is set
- `GET /events` — authenticated SSE cycle events (payloads are redacted)

The `/mcp`, `/events`, and `/metrics` endpoints require bearer authentication
when `UDDNS_MCP_AUTH_TOKEN` is configured.

### Bearer authentication

Set `UDDNS_MCP_AUTH_TOKEN` to require this header on every request:

```http
Authorization: Bearer replace-me
```

### TLS and remote binding

```env
UDDNS_MCP_TLS_CERT=/path/to/cert.pem
UDDNS_MCP_TLS_KEY=/path/to/key.pem
```

Non-loopback binds require both a bearer token and TLS. uDDNS refuses to start
without them when `UDDNS_MCP_HOST` is not loopback.

HTTP MCP on loopback also requires `UDDNS_MCP_AUTH_TOKEN` by default (any local
process can otherwise call destructive tools). Set
`UDDNS_MCP_ALLOW_INSECURE_LOOPBACK=true` only for trusted single-user sidecars.

The optional `compose.mcp.yml` overlay binds MCP to `127.0.0.1` inside the
container (no published ports). For a published non-loopback MCP service, set
`UDDNS_MCP_HOST=0.0.0.0` plus auth token and TLS cert mounts.
