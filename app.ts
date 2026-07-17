/**
 * Entry point for the DDNS updater daemon.
 */

import { loadConfig } from './lib/config.js';
import { createLogger, formatError } from './lib/log.js';
import { getProvider } from './lib/providers/index.js';
import { createUpdater } from './lib/updater.js';

const log = createLogger();

try {
  const config = loadConfig();
  const provider = getProvider(config.provider);
  const updater = createUpdater({ config, provider, log });

  const handle = await updater.start();

  function shutdown(signal: string): void {
    log.info(`Received ${signal}; shutting down.`);
    handle.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', formatError(error));
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', formatError(reason));
  });
} catch (error) {
  log.error('Failed to start updater', formatError(error));
  process.exit(1);
}
