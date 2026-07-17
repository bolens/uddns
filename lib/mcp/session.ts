/**
 * Shared updater session for MCP tools / resources / HTTP and stdio servers.
 */

import { loadConfig } from '../config.js';
import type { Logger } from '../log.js';
import { getProvider } from '../providers/index.js';
import type { AppConfig, Provider } from '../schemas/provider.js';
import { createUpdater, type Updater } from '../updater.js';

export type McpSession = {
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  log: Logger;
};

export type CreateMcpSessionOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: { config: AppConfig; provider: Provider; log: Logger }) => Updater;
};

export function createMcpSession(options: CreateMcpSessionOptions): McpSession {
  const env = options.env ?? process.env;
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const createUpdaterFn = options.createUpdaterFn ?? createUpdater;

  const config = loadConfigFn(env);
  const provider = getProviderFn(config.provider);
  const updater = createUpdaterFn({ config, provider, log: options.log });

  return { config, provider, updater, log: options.log };
}
