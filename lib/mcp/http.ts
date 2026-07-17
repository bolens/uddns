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
import type { McpConfig } from './config.js';
import { isLoopbackMcpHost } from './config.js';
import { createUddnsMcpServer } from './server.js';
import type { McpSession } from './session.js';

export type McpHttpServer = {
  app: Express;
  httpServer: HttpServer;
  close: () => Promise<void>;
  url: string;
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

/**
 * Start a Streamable HTTP MCP server bound according to mcpConfig.
 */
export async function startMcpHttpServer(options: {
  session: McpSession;
  mcpConfig: McpConfig;
  log: Logger;
}): Promise<McpHttpServer> {
  const { session, mcpConfig, log } = options;
  const app = createMcpExpressApp({ host: mcpConfig.host });
  const transports = new Map<string, StreamableHTTPServerTransport>();

  if (!mcpConfig.authToken && isLoopbackMcpHost(mcpConfig.host)) {
    log.warn(
      'MCP HTTP auth token unset; loopback only — set UDDNS_MCP_AUTH_TOKEN for safer local use',
    );
  }

  app.use(requireBearer(mcpConfig.authToken));

  app.post('/mcp', async (req, res) => {
    try {
      const sessionIdHeader = req.header('mcp-session-id');
      let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;

      if (transport) {
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionIdHeader && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            transports.set(sessionId, transport!);
          },
        });
        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) {
            transports.delete(id);
          }
        };
        const server = createUddnsMcpServer(session);
        // SDK optional callbacks vs exactOptionalPropertyTypes
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res, req.body);
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
    const transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
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
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
