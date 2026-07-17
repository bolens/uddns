/**
 * Entry point for the uDDNS MCP server (stdio or Streamable HTTP).
 */

import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './lib/config.js';
import type { McpConfig, McpTransport } from './lib/mcp/config.js';
import { loadMcpConfig } from './lib/mcp/config.js';
import { startMcpHttpServer, type McpHttpServer } from './lib/mcp/http.js';
import { createStderrLogger } from './lib/mcp/log.js';
import { createUddnsMcpServer } from './lib/mcp/server.js';
import { createMcpSession, type McpSession } from './lib/mcp/session.js';
import { createLogger, formatError, type Logger } from './lib/log.js';
import { getProvider } from './lib/providers/index.js';
import type { AppConfig, Provider } from './lib/schemas/provider.js';
import type { Updater, UpdaterOptions } from './lib/updater.js';

export type AppOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log?: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  loadMcpConfigFn?: (
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
    options?: { transportOverride?: McpTransport | null },
  ) => McpConfig;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
  createSessionFn?: (options: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    log: Logger;
    loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
    getProviderFn?: (id: string) => Provider;
    createUpdaterFn?: (options: UpdaterOptions) => Updater;
  }) => McpSession | Promise<McpSession>;
  startHttpFn?: (options: {
    session: McpSession;
    mcpConfig: McpConfig;
    log: Logger;
  }) => Promise<McpHttpServer>;
  connectStdioFn?: (session: McpSession) => Promise<{ close: () => Promise<void> }>;
  on?: (event: string, listener: (value?: unknown) => void) => void;
  exit?: (code: number) => void;
};

export function parseTransportOverride(argv: string[]): McpTransport | null {
  for (const arg of argv) {
    if (arg === '--transport=http' || arg === '--transport=stdio') {
      return arg.slice('--transport='.length) as McpTransport;
    }
  }
  const index = argv.indexOf('--transport');
  if (index >= 0) {
    const value = argv[index + 1]?.toLowerCase();
    if (value === 'http' || value === 'stdio') {
      return value;
    }
    throw new Error('--transport must be "stdio" or "http"');
  }
  return null;
}

async function connectStdio(session: McpSession): Promise<{ close: () => Promise<void> }> {
  /* v8 ignore start: real stdio transport is only exercised by MCP hosts */
  const server = createUddnsMcpServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
    },
  };
  /* v8 ignore stop */
}

export async function main(options: AppOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const transportOverride = parseTransportOverride(argv);
  const useStderrLogger =
    (transportOverride ?? env['UDDNS_MCP_TRANSPORT'] ?? 'stdio') !== 'http' &&
    !argv.includes('--check-config');
  const log = options.log ?? (useStderrLogger ? createStderrLogger() : createLogger());
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const loadMcpConfigFn = options.loadMcpConfigFn ?? loadMcpConfig;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const createSessionFn = options.createSessionFn ?? createMcpSession;
  const startHttpFn = options.startHttpFn ?? startMcpHttpServer;
  const connectStdioFn = options.connectStdioFn ?? connectStdio;
  const on =
    options.on ??
    ((event: string, listener: (value?: unknown) => void) => {
      process.on(event, listener);
    });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let activeSession: McpSession | null = null;
  let httpServer: McpHttpServer | null = null;
  let stdioHandle: { close: () => Promise<void> } | null = null;

  async function cleanup(): Promise<void> {
    const stopAccounts = (activeSession?.accounts ?? []).map((account) => account.updater.stop());
    if (stopAccounts.length === 0 && activeSession) {
      stopAccounts.push(activeSession.updater.stop());
    }
    const results = await Promise.allSettled([
      ...stopAccounts,
      httpServer?.close() ?? Promise.resolve(),
      stdioHandle?.close() ?? Promise.resolve(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      throw failure.reason;
    }
  }

  try {
    if (argv.includes('--check-config')) {
      const config = loadConfigFn(env);
      const provider = getProviderFn(config.provider);
      log.success(`Configuration is valid for ${provider.label} (${provider.id})`);
      return;
    }

    const mcpConfig = loadMcpConfigFn(env, { transportOverride });
    const session = await createSessionFn({
      env,
      log,
      loadConfigFn,
      getProviderFn,
      ...(options.createUpdaterFn ? { createUpdaterFn: options.createUpdaterFn } : {}),
    });
    activeSession = session;
    let shuttingDown = false;

    async function shutdown(signal: string, code: number): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      log.info(`Received ${signal}; shutting down.`);
      try {
        await cleanup();
      } catch (error) {
        log.error('Graceful shutdown failed', formatError(error));
        code = 1;
      }
      exit(code);
    }

    on('SIGINT', () => {
      void shutdown('SIGINT', 0);
    });
    on('SIGTERM', () => {
      void shutdown('SIGTERM', 0);
    });

    on('uncaughtException', (error) => {
      log.error('Uncaught exception; exiting', formatError(error));
      void shutdown('uncaughtException', 1);
    });

    on('unhandledRejection', (reason) => {
      log.error('Unhandled promise rejection; exiting', formatError(reason));
      void shutdown('unhandledRejection', 1);
    });

    if (mcpConfig.transport === 'http') {
      const accounts = session.accounts?.length ? session.accounts : [{ updater: session.updater }];
      await Promise.all(accounts.map((account) => account.updater.start()));
      httpServer = await startHttpFn({ session, mcpConfig, log });
      log.info(`MCP HTTP listening on ${httpServer.url}`, {
        host: mcpConfig.host,
        port: mcpConfig.port,
        tls: Boolean(mcpConfig.tlsCert),
        auth: Boolean(mcpConfig.authToken),
        accounts: session.accounts?.map((account) => account.id) ?? [
          session.accountId ?? 'default',
        ],
      });
      return;
    }

    stdioHandle = await connectStdioFn(session);
    log.info('MCP stdio server connected');
  } catch (error) {
    log.error('Failed to start uDDNS MCP server', formatError(error));
    try {
      await cleanup();
    } catch (cleanupError) {
      log.error('MCP startup cleanup failed', formatError(cleanupError));
    }
    exit(1);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  /* v8 ignore next: only runs when executed as the main script, never under test */
  await main();
}
