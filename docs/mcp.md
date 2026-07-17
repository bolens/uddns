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

## Streamable HTTP

The endpoint is `/mcp`. Defaults:

```env
UDDNS_MCP_TRANSPORT=http
UDDNS_MCP_HOST=127.0.0.1
UDDNS_MCP_PORT=3923
```

### Bearer authentication

Set `UDDNS_MCP_AUTH_TOKEN` to require this header on every request:

```http
Authorization: Bearer replace-me
```

### TLS and remote binding

Provide PEM file paths to serve HTTPS:

```env
UDDNS_MCP_TLS_CERT=/etc/uddns/cert.pem
UDDNS_MCP_TLS_KEY=/etc/uddns/key.pem
```

Non-loopback binds require both a bearer token and TLS. uDDNS refuses to start
remote cleartext or unauthenticated HTTP. Loopback may use plain HTTP; an unset
token emits a warning.

Example remote configuration:

```env
UDDNS_MCP_TRANSPORT=http
UDDNS_MCP_HOST=0.0.0.0
UDDNS_MCP_PORT=3923
UDDNS_MCP_AUTH_TOKEN=replace-me
UDDNS_MCP_TLS_CERT=/etc/uddns/cert.pem
UDDNS_MCP_TLS_KEY=/etc/uddns/key.pem
```

Certificate issuance and renewal are intentionally external to uDDNS.
