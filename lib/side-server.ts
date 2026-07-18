/**
 * Lightweight health / metrics / SSE side server (node:http).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { redact } from './log.js';
import type { CycleEvent } from './schemas/cycle.js';
import type { UpdaterStatus } from './updater.js';

export type SideServerConfig = {
  host: string;
  port: number;
  metricsEnabled: boolean;
  authToken?: string | null;
};

export type MetricsSnapshot = {
  cyclesTotal: Record<string, number>;
  updatesTotal: number;
  discoverErrors: number;
  lastSuccessAt: string | null;
};

export type SideServerOptions = {
  config: SideServerConfig;
  getStatus: () => StatusPayload;
  getMetrics?: () => MetricsSnapshot;
  onEventSubscribe?: (listener: (event: CycleEvent) => void) => () => void;
};

export type StatusPayload =
  | UpdaterStatus
  | { accounts: Array<{ id: string; status: UpdaterStatus }> };

export type SideServer = {
  server: Server;
  close: () => Promise<void>;
  url: string;
};

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function bearerMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string | null | undefined,
): boolean {
  if (!authToken) {
    return true;
  }
  if (bearerMatches(authToken, req.headers.authorization)) {
    return true;
  }
  writeJson(res, 401, { error: 'unauthorized' });
  return false;
}

export function renderPrometheus(metrics: MetricsSnapshot): string {
  const lines: string[] = [];
  lines.push('# HELP uddns_cycles_total Total updater cycles by status');
  lines.push('# TYPE uddns_cycles_total counter');
  for (const [status, count] of Object.entries(metrics.cyclesTotal)) {
    lines.push(`uddns_cycles_total{status="${status}"} ${count}`);
  }
  lines.push('# HELP uddns_updates_total Successful DNS updates');
  lines.push('# TYPE uddns_updates_total counter');
  lines.push(`uddns_updates_total ${metrics.updatesTotal}`);
  lines.push('# HELP uddns_discover_errors_total Public IP discovery failures');
  lines.push('# TYPE uddns_discover_errors_total counter');
  lines.push(`uddns_discover_errors_total ${metrics.discoverErrors}`);
  if (metrics.lastSuccessAt) {
    const age = Math.max(0, (Date.now() - Date.parse(metrics.lastSuccessAt)) / 1000);
    lines.push('# HELP uddns_last_success_age_seconds Seconds since last successful cycle');
    lines.push('# TYPE uddns_last_success_age_seconds gauge');
    lines.push(`uddns_last_success_age_seconds ${age}`);
  }
  return `${lines.join('\n')}\n`;
}

export function createMetricsTracker(): {
  record: (event: CycleEvent) => void;
  snapshot: () => MetricsSnapshot;
} {
  const cyclesTotal: Record<string, number> = {};
  let updatesTotal = 0;
  let discoverErrors = 0;
  let lastSuccessAt: string | null = null;

  return {
    record(event) {
      cyclesTotal[event.status] = (cyclesTotal[event.status] ?? 0) + 1;
      if (event.status === 'updated') {
        updatesTotal += 1;
        lastSuccessAt = event.at;
      }
      if (event.status === 'unchanged' && !event.dryRun) {
        lastSuccessAt = event.at;
      }
      if (event.discoveryErrors?.v4 || event.discoveryErrors?.v6) {
        discoverErrors += 1;
      }
    },
    snapshot() {
      return {
        cyclesTotal: { ...cyclesTotal },
        updatesTotal,
        discoverErrors,
        lastSuccessAt,
      };
    },
  };
}

export function readiness(status: StatusPayload): {
  ok: boolean;
  status: StatusPayload;
} {
  const statuses =
    'accounts' in status ? status.accounts.map((account) => account.status) : [status];
  const ok =
    statuses.length > 0 &&
    statuses.every(
      (account) =>
        account.running &&
        !account.stopping &&
        account.lastSuccessAt !== null &&
        account.lastError === null,
    );
  return { ok, status };
}

export async function startSideServer(options: SideServerOptions): Promise<SideServer> {
  const { config, getStatus, getMetrics, onEventSubscribe } = options;
  const sseClients = new Set<ServerResponse>();

  const unsubscribe = onEventSubscribe?.((event) => {
    const data = `data: ${JSON.stringify(redact(event))}\n\n`;
    for (const client of sseClients) {
      client.write(data);
    }
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url?.split('?')[0] ?? '/';
    if (req.method === 'GET' && url === '/healthz') {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url === '/readyz') {
      const result = readiness(getStatus());
      // Keep probe payloads minimal; detailed status is available via MCP tools.
      writeJson(res, result.ok ? 200 : 503, { ok: result.ok });
      return;
    }
    if (req.method === 'GET' && url === '/metrics') {
      if (!requireAuth(req, res, config.authToken)) {
        return;
      }
      if (!config.metricsEnabled || !getMetrics) {
        writeJson(res, 404, { error: 'metrics disabled' });
        return;
      }
      const body = renderPrometheus(getMetrics());
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url === '/events') {
      if (!requireAuth(req, res, config.authToken)) {
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }
    writeJson(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    server,
    url: `http://${config.host}:${port}`,
    async close() {
      unsubscribe?.();
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
