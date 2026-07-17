# Deployment

Build first, then use a supervisor so fatal errors restart the core updater.
The process handles `SIGINT`/`SIGTERM` (and `SIGHUP` for config reload), stops
scheduling work, waits for active work, and exits.

## systemd

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

## Docker / GHCR

Published images (on version tags):

```bash
docker pull ghcr.io/bolens/uddns:latest
```

Build locally:

```bash
docker build -t uddns .
docker run -d --name uddns --restart unless-stopped \
  --env-file .env \
  -v uddns-state:/data \
  uddns
```

The image stores checkpoints at `/data/state.json` and history at
`/data/history.json`. Health probes hit `http://127.0.0.1:3924/healthz`
(enabled by default in the image).

The entrypoint is `node` with default command `dist/app.js`. To run MCP HTTP:

```bash
docker run -d --name uddns-mcp --restart unless-stopped \
  --env-file .env \
  -p 3923:3923 \
  -v uddns-state:/data \
  uddns dist/mcp.js --transport=http
```

Configure bearer token and TLS for non-loopback binds. See
[Optional MCP server](mcp.md).

## Compose

`compose.yml` loads `.env`, persists checkpoints, and enables healthchecks:

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f
```

Overlays:

- `compose.mcp.yml` — Streamable HTTP MCP on port 3923
- `compose.multi.yml` — two single-account services
- `examples/uddns.multi.yaml` — multi-account YAML via `UDDNS_CONFIG_FILE`

`podman-compose` can use the same files.

## Health and metrics

Set `UDDNS_HEALTH=1` to bind the side server (`UDDNS_HEALTH_HOST` /
`UDDNS_HEALTH_PORT`, defaults `127.0.0.1:3924`):

- `GET /healthz` — liveness
- `GET /readyz` — readiness + status
- `GET /metrics` — Prometheus text when `UDDNS_METRICS=1`
- `GET /events` — SSE cycle events
