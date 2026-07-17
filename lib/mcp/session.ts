/**
 * Shared updater session(s) for MCP tools / resources / HTTP and stdio servers.
 */

import { resolveAccounts } from '../config-file.js';
import type { HistoryStore } from '../history.js';
import type { Logger } from '../log.js';
import { getProvider } from '../providers/index.js';
import { createRuntimeBundle } from '../runtime.js';
import type { CycleEvent } from '../schemas/cycle.js';
import type { AppConfig, Provider } from '../schemas/provider.js';
import type { createMetricsTracker } from '../side-server.js';
import type { Updater, UpdaterOptions } from '../updater.js';

export type McpAccount = {
  id: string;
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  history?: HistoryStore | null | undefined;
  metrics?: ReturnType<typeof createMetricsTracker> | undefined;
  eventListeners?: Set<(event: CycleEvent) => void> | undefined;
};

export type McpSession = {
  /** Default/active account (first loaded account). */
  accountId?: string | undefined;
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  log: Logger;
  history?: HistoryStore | null | undefined;
  metrics?: ReturnType<typeof createMetricsTracker> | undefined;
  eventListeners?: Set<(event: CycleEvent) => void> | undefined;
  accounts?: McpAccount[] | undefined;
};

export type CreateMcpSessionOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  resolveAccountsFn?: (
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => Array<{ id: string; config: AppConfig }> | Promise<Array<{ id: string; config: AppConfig }>>;
  getProviderFn?: (id: string) => Provider;
  /** When set, replaces the default updater factory inside createRuntimeBundle. */
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
};

function toSession(log: Logger, accounts: McpAccount[]): McpSession {
  const primary = accounts[0];
  if (!primary) {
    throw new Error('No MCP accounts configured');
  }
  return {
    accountId: primary.id,
    config: primary.config,
    provider: primary.provider,
    updater: primary.updater,
    log,
    history: primary.history,
    metrics: primary.metrics,
    eventListeners: primary.eventListeners,
    accounts,
  };
}

export function getMcpAccount(session: McpSession, accountId?: string | null): McpAccount {
  const accounts =
    session.accounts ??
    ([
      {
        id: session.accountId ?? 'default',
        config: session.config,
        provider: session.provider,
        updater: session.updater,
        history: session.history,
        metrics: session.metrics,
        eventListeners: session.eventListeners,
      },
    ] satisfies McpAccount[]);
  const primaryId = session.accountId ?? accounts[0]?.id ?? 'default';
  if (!accountId || accountId === primaryId) {
    return accounts[0]!;
  }
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new Error(
      `Unknown account "${accountId}". Known: ${accounts.map((entry) => entry.id).join(', ')}`,
    );
  }
  return account;
}

export async function createMcpSession(options: CreateMcpSessionOptions): Promise<McpSession> {
  const env = options.env ?? process.env;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const resolveAccountsFn =
    options.resolveAccountsFn ??
    (options.loadConfigFn
      ? (resolveEnv: NodeJS.ProcessEnv | Record<string, string | undefined>) => [
          { id: 'default', config: options.loadConfigFn!(resolveEnv) },
        ]
      : resolveAccounts);

  const accountsLoaded = await Promise.resolve(resolveAccountsFn(env));
  const accounts = accountsLoaded.map((account) => {
    const bundle = createRuntimeBundle({
      config: account.config,
      log: options.log,
      accountId: account.id,
      getProviderFn,
      ...(options.createUpdaterFn ? { createUpdaterFn: options.createUpdaterFn } : {}),
    });
    return {
      id: account.id,
      config: bundle.config,
      provider: bundle.provider,
      updater: bundle.updater,
      history: bundle.history,
      metrics: bundle.metrics,
      eventListeners: bundle.eventListeners,
    } satisfies McpAccount;
  });

  return toSession(options.log, accounts);
}
