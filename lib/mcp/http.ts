/**
 * Streamable HTTP MCP transport with bearer auth and optional TLS.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express, NextFunction, Request, Response } from 'express';

import type { Logger } from '../log.js';
import { redact } from '../log.js';
import type { CycleEvent } from '../schemas/cycle.js';
import { readiness, renderPrometheus, type MetricsSnapshot } from '../side-server.js';
import type { McpConfig } from './config.js';
import { isLoopbackMcpHost } from './config.js';
import { createUddnsMcpServer, type UddnsMcpServer } from './server.js';
import type { McpAccount, McpSession } from './session.js';

export type McpHttpServer = {
  app: Express;
  httpServer: HttpServer;
  close: () => Promise<void>;
  url: string;
};

type HttpSession = {
  transport: StreamableHTTPServerTransport;
  server: UddnsMcpServer;
};

function bearerMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = header.slice('Bearer '.length);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

function requireBearer(authToken: string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!authToken) {
      next();
      return;
    }
    if (!bearerMatches(authToken, req.header('authorization'))) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    next();
  };
}

async function listen(httpServer: HttpServer, host: string, port: number): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  return httpServer.address() as AddressInfo;
}

function sessionAccounts(session: McpSession): McpAccount[] {
  if (session.accounts?.length) {
    return session.accounts;
  }
  return [
    {
      id: session.accountId ?? 'default',
      config: session.config,
      provider: session.provider,
      updater: session.updater,
      history: session.history,
      metrics: session.metrics,
      eventListeners: session.eventListeners,
    },
  ];
}

function mergeMetrics(accounts: McpAccount[]): MetricsSnapshot {
  const cyclesTotal: Record<string, number> = {};
  let updatesTotal = 0;
  let discoverErrors = 0;
  let lastSuccessAt: string | null = null;
  for (const account of accounts) {
    const snapshot = account.metrics?.snapshot() ?? {
      cyclesTotal: {},
      updatesTotal: 0,
      discoverErrors: 0,
      lastSuccessAt: null,
    };
    for (const [status, count] of Object.entries(snapshot.cyclesTotal)) {
      cyclesTotal[status] = (cyclesTotal[status] ?? 0) + count;
    }
    updatesTotal += snapshot.updatesTotal;
    discoverErrors += snapshot.discoverErrors;
    if (snapshot.lastSuccessAt && (!lastSuccessAt || snapshot.lastSuccessAt > lastSuccessAt)) {
      lastSuccessAt = snapshot.lastSuccessAt;
    }
  }
  return { cyclesTotal, updatesTotal, discoverErrors, lastSuccessAt };
}

/**
 * Start a Streamable HTTP MCP server bound according to mcpConfig.
 */
export async function startMcpHttpServer(options: {
  session: McpSession;
  mcpConfig: McpConfig;
  log: Logger;
}): Promise<McpHttpServer> {
  const { session, mcpConfig, log } = options;
  const accounts = sessionAccounts(session);
  const app = createMcpExpressApp({ host: mcpConfig.host });
  const sessions = new Map<string, HttpSession>();
  const sseClients = new Set<Response>();

  if (!mcpConfig.authToken && isLoopbackMcpHost(mcpConfig.host)) {
    log.warn(
      'MCP HTTP running with UDDNS_MCP_ALLOW_INSECURE_LOOPBACK; set UDDNS_MCP_AUTH_TOKEN for safer local use',
    );
  }

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get('/readyz', (_req, res) => {
    const result = readiness({
      accounts: accounts.map((account) => ({
        id: account.id,
        status: account.updater.getStatus(),
      })),
    });
    // Probe-only payload; full status stays on authenticated MCP tools.
    res.status(result.ok ? 200 : 503).json({ ok: result.ok });
  });

  const requireAuth = requireBearer(mcpConfig.authToken);

  app.get('/metrics', requireAuth, (_req, res) => {
    res
      .status(200)
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(renderPrometheus(mergeMetrics(accounts)));
  });

  app.use(requireAuth);

  app.get('/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    sseClients.add(res);
    const listener = (event: CycleEvent): void => {
      res.write(`data: ${JSON.stringify(redact(event))}\n\n`);
    };
    for (const account of accounts) {
      account.eventListeners?.add(listener);
    }
    req.on('close', () => {
      sseClients.delete(res);
      for (const account of accounts) {
        account.eventListeners?.delete(listener);
      }
    });
  });

  app.post('/mcp', async (req, res) => {
    try {
      const sessionIdHeader = req.header('mcp-session-id');
      let entry = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;

      if (entry) {
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionIdHeader && isInitializeRequest(req.body)) {
        let server: UddnsMcpServer | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            if (server) {
              sessions.set(sessionId, { transport, server });
            }
          },
        });
        server = createUddnsMcpServer(session);
        transport.onclose = () => {
          const id = transport.sessionId;
          if (!id) {
            return;
          }
          const closed = sessions.get(id);
          sessions.delete(id);
          closed?.server.dispose();
        };
        // SDK optional callbacks vs exactOptionalPropertyTypes
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId && server) {
          sessions.set(transport.sessionId, { transport, server });
        }
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    } catch (error) {
      log.error('MCP HTTP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  app.delete('/mcp', async (req, res) => {
    const sessionIdHeader = req.header('mcp-session-id');
    const entry = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;
    if (entry) {
      await entry.transport.handleRequest(req, res);
      return;
    }
    res.status(404).send('Session not found');
  });

  const httpServer =
    mcpConfig.tlsCert && mcpConfig.tlsKey
      ? createHttpsServer(
          {
            cert: await readFile(mcpConfig.tlsCert),
            key: await readFile(mcpConfig.tlsKey),
          },
          app,
        )
      : createHttpServer(app);

  const address = await listen(httpServer, mcpConfig.host, mcpConfig.port);
  const scheme = mcpConfig.tlsCert ? 'https' : 'http';
  const url = `${scheme}://${mcpConfig.host}:${address.port}/mcp`;

  return {
    app,
    httpServer,
    url,
    async close() {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      const entries = Array.from(sessions.values());
      for (const entry of entries) {
        entry.server.dispose();
        await entry.transport.close();
        await entry.server.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
