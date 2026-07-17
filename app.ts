/**
 * Entry point for the uDDNS updater daemon.
 */

import { pathToFileURL } from 'node:url';

import { loadConfig } from './lib/config.js';
import { createLogger, formatError, type Logger } from './lib/log.js';
import { getProvider } from './lib/providers/index.js';
import type { AppConfig, Provider } from './lib/schemas/provider.js';
import { createUpdater } from './lib/updater.js';

type Updater = ReturnType<typeof createUpdater>;

export type AppOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log?: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: { config: AppConfig; provider: Provider; log: Logger }) => Updater;
  on?: (event: string, listener: (value?: unknown) => void) => void;
  exit?: (code: number) => void;
};

export async function main(options: AppOptions = {}): Promise<void> {
  const log = options.log ?? createLogger();
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const createUpdaterFn = options.createUpdaterFn ?? createUpdater;
  const on =
    options.on ??
    ((event: string, listener: (value?: unknown) => void) => {
      process.on(event, listener);
    });
  const exit = options.exit ?? ((code: number) => process.exit(code));

  try {
    const config = loadConfigFn(env);
    const provider = getProviderFn(config.provider);

    if (argv.includes('--check-config')) {
      log.success(`Configuration is valid for ${provider.label} (${provider.id})`);
      return;
    }

    const updater = createUpdaterFn({ config, provider, log });
    let shuttingDown = false;

    async function shutdown(signal: string, code: number): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      log.info(`Received ${signal}; shutting down.`);
      try {
        await updater.stop();
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

    // Process state is undefined after an uncaught error; stop cleanly and exit
    // non-zero so a supervisor restarts us with a fresh process.
    on('uncaughtException', (error) => {
      log.error('Uncaught exception; exiting', formatError(error));
      void shutdown('uncaughtException', 1);
    });
    on('unhandledRejection', (reason) => {
      log.error('Unhandled promise rejection; exiting', formatError(reason));
      void shutdown('unhandledRejection', 1);
    });

    await updater.start();
  } catch (error) {
    log.error('Failed to start updater', formatError(error));
    exit(1);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  /* v8 ignore next: only runs when executed as the main script, never under test */
  await main();
}
