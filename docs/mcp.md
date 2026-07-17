# Optional MCP server

The core uDDNS daemon runs with `vp run start` and does not require MCP. The
optional MCP entrypoint exposes the same updater capabilities over stdio or
Streamable HTTP.

Run either the core daemon or an MCP mode for a given environment/state file.
Do not run both against the same provider configuration at once, because both
processes can issue updates.

## Run modes

| Command           | Mode                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `vp run mcp:http` | HTTP MCP with the updater loop started automatically             |
| `vp run mcp`      | stdio MCP; the loop remains stopped until `start_loop` is called |

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

## Tools

- `list_providers` — list supported Dynamic DNS providers
- `get_public_ip` — discover the current public IPv4 and IPv6 addresses
- `get_config` — return the active configuration with secrets redacted
- `check_once` — run one overlap-safe update cycle
- `force_update` — force updates for all hosts ignoring checkpoints
- `dry_run` — show which hosts would update without calling the provider
- `get_status` — inspect loop, interval, cycle, IP, and host checkpoint state
- `set_interval` — change the live interval (minimum 1000 ms)
- `start_loop` — run an immediate check and start interval scheduling
- `stop_loop` — stop scheduling and wait for an active cycle

## Prompts

- `setup_provider`
- `diagnose_update`

## Resources

- `uddns://config`
- `uddns://public-ip`
- `uddns://status`
- `uddns://history`

## Streamable HTTP

The endpoint is `/mcp`. Defaults:

```env
UDDNS_MCP_TRANSPORT=http
UDDNS_MCP_HOST=127.0.0.1
UDDNS_MCP_PORT=3923
```

Operational endpoints:

- `GET /healthz` — liveness, without bearer auth
- `GET /readyz` — updater readiness and status, without bearer auth; returns
  503 until the updater has completed a successful cycle
- `GET /metrics` — Prometheus cycle/update/discovery metrics, without bearer
  auth
- `GET /events` — authenticated SSE cycle events

The `/mcp` and `/events` endpoints require bearer authentication when
`UDDNS_MCP_AUTH_TOKEN` is configured.

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
