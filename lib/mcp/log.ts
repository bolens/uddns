/**
 * Logger that never writes to stdout (reserved for stdio MCP JSON-RPC).
 */

import { createLogger, type Logger, type LoggerOptions } from '../log.js';

export function createStderrLogger(options: LoggerOptions = {}): Logger {
  const write = (...args: unknown[]) => {
    console.error(...args);
  };
  return createLogger({
    ...options,
    info: options.info ?? write,
    warn: options.warn ?? write,
    error: options.error ?? write,
    debug: options.debug ?? write,
  });
}
