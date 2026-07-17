/**
 * Shared updater session for MCP tools / resources / HTTP and stdio servers.
 */

import { loadConfig } from '../config.js';
import type { HistoryStore } from '../history.js';
import type { Logger } from '../log.js';
import { getProvider } from '../providers/index.js';
import { createRuntimeBundle } from '../runtime.js';
import type { CycleEvent } from '../schemas/cycle.js';
import type { AppConfig, Provider } from '../schemas/provider.js';
import type { createMetricsTracker } from '../side-server.js';
import { createUpdater, type Updater } from '../updater.js';

export type McpSession = {
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  log: Logger;
  history?: HistoryStore | null;
  metrics?: ReturnType<typeof createMetricsTracker>;
  eventListeners?: Set<(event: CycleEvent) => void>;
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

  if (options.createUpdaterFn) {
    const config = loadConfigFn(env);
    const provider = getProviderFn(config.provider);
    const updater = options.createUpdaterFn({ config, provider, log: options.log });
    return { config, provider, updater, log: options.log, history: null };
  }

  const config = loadConfigFn(env);
  const bundle = createRuntimeBundle({
    config,
    log: options.log,
    getProviderFn,
    createUpdaterFn: (updaterOptions) => createUpdater(updaterOptions),
  });

  return {
    config: bundle.config,
    provider: bundle.provider,
    updater: bundle.updater,
    log: options.log,
    history: bundle.history,
    metrics: bundle.metrics,
    eventListeners: bundle.eventListeners,
  };
}
