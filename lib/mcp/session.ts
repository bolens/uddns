/**
 * Shared updater session(s) for MCP tools / resources / HTTP and stdio servers.
 */

import {
  resolveAccounts,
  runnableAccounts,
  resolveFailoverTargets,
  type LoadedAccount,
} from '../config-file.js';
import type { HistoryStore } from '../history.js';
import type { Logger } from '../log.js';
import { getProvider } from '../providers/index.js';
import { createRuntimeBundle } from '../runtime.js';
import type { CycleEvent } from '../schemas/cycle.js';
import type { AppConfig, Provider } from '../schemas/provider.js';
import type { createMetricsTracker } from '../side-server.js';
import type { Updater, UpdaterOptions } from '../updater.js';

export type McpStandbyAccount = {
  id: string;
  config: AppConfig;
  provider: Provider;
  role: 'failover';
};

export type McpAccount = {
  id: string;
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  history?: HistoryStore | null | undefined;
  metrics?: ReturnType<typeof createMetricsTracker> | undefined;
  eventListeners?: Set<(event: CycleEvent) => void> | undefined;
  flushNotifications?: (() => Promise<void>) | undefined;
  role?: 'primary';
};

export type McpSession = {
  /** Default/active account (first loaded primary account). */
  accountId?: string | undefined;
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  log: Logger;
  history?: HistoryStore | null | undefined;
  metrics?: ReturnType<typeof createMetricsTracker> | undefined;
  eventListeners?: Set<(event: CycleEvent) => void> | undefined;
  accounts?: McpAccount[] | undefined;
  /** Failover standby accounts (validated, not started as updater loops). */
  standbyAccounts?: McpStandbyAccount[] | undefined;
};

export type CreateMcpSessionOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  resolveAccountsFn?: (
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => LoadedAccount[] | Promise<LoadedAccount[]>;
  getProviderFn?: (id: string) => Provider;
  /** When set, replaces the default updater factory inside createRuntimeBundle. */
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
};

function toSession(
  log: Logger,
  accounts: McpAccount[],
  standbyAccounts: McpStandbyAccount[] = [],
): McpSession {
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
    ...(standbyAccounts.length > 0 ? { standbyAccounts } : {}),
  };
}

export function getMcpAccount(session: McpSession, accountId?: string | null): McpAccount {
  if (accountId) {
    const standby = session.standbyAccounts?.find((entry) => entry.id === accountId);
    if (standby) {
      throw new Error(
        `Account "${accountId}" is a failover standby; use the primary account that references it`,
      );
    }
  }
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
        role: 'primary',
      },
    ] satisfies McpAccount[]);
  if (!accountId || accounts.length <= 1) {
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
      ? (resolveEnv: NodeJS.ProcessEnv | Record<string, string | undefined>): LoadedAccount[] => [
          {
            id: 'default',
            config: options.loadConfigFn!(resolveEnv),
            role: 'primary',
            failoverAccountIds: [],
          },
        ]
      : resolveAccounts);

  const accountsLoaded = await Promise.resolve(resolveAccountsFn(env));
  const primaryLoaded = runnableAccounts(accountsLoaded);
  if (primaryLoaded.length === 0) {
    throw new Error(
      accountsLoaded.length === 0
        ? 'No MCP accounts configured'
        : 'No primary accounts configured (all accounts are failover standbys)',
    );
  }

  const accounts = primaryLoaded.map((account) => {
    const bundle = createRuntimeBundle({
      config: account.config,
      log: options.log,
      accountId: account.id,
      failoverTargets: resolveFailoverTargets(account, accountsLoaded, getProviderFn),
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
      flushNotifications: () => bundle.flushNotifications(),
      role: 'primary' as const,
    } satisfies McpAccount;
  });

  const standbyAccounts = accountsLoaded
    .filter((account) => account.role === 'failover')
    .map(
      (account) =>
        ({
          id: account.id,
          config: account.config,
          provider: getProviderFn(account.config.provider),
          role: 'failover' as const,
        }) satisfies McpStandbyAccount,
    );

  return toSession(options.log, accounts, standbyAccounts);
}
