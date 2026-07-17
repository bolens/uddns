# Deployment

Build first, then use a supervisor so fatal errors restart the core updater.
The process handles `SIGINT`/`SIGTERM`, stops scheduling work, waits for active
work, and exits.

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

## Docker

The multi-stage `Dockerfile` builds uDDNS and runs it as an unprivileged user:

```bash
docker build -t uddns .
docker run -d --name uddns --restart unless-stopped \
  --env-file .env \
  -v uddns-state:/data \
  uddns
```

The image stores checkpoints at `/data/state.json`. The core image only makes
outbound HTTPS/DNS requests and exposes no inbound port.

To deploy the optional Streamable HTTP server instead, override the container
command with `node dist/mcp.js --transport=http`, configure the required bearer
token and TLS files, mount those files read-only, and publish port 3923. See
[Optional MCP server](mcp.md) for its security requirements.

## Compose

`compose.yml` loads `.env` and persists checkpoints in a named volume:

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f
```

`podman-compose` can use the same file.
