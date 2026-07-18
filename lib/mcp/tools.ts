/**
 * Pure MCP tool handlers (no wire-protocol types).
 */

import { discoverPublicIP, type PublicIPDiscovery } from '../ip.js';
import { redact } from '../log.js';
import { listProviders } from '../providers/index.js';
import { getProviderConfigIssues } from '../schemas/config.js';
import type { AppConfig, CheckResult } from '../schemas/provider.js';
import type { BusyCheckResult, UpdaterStatus } from '../updater.js';
import { getMcpAccount, type McpAccount, type McpSession } from './session.js';

function discoverFromConfig(config: AppConfig): () => Promise<PublicIPDiscovery> {
  return () =>
    discoverPublicIP({
      timeoutMs: config.ipTimeoutMs,
      dnsFallback: config.ipDnsFallback,
      ...(config.ipHttpsV4 ? { httpsV4: config.ipHttpsV4 } : {}),
      ...(config.ipHttpsV6 ? { httpsV6: config.ipHttpsV6 } : {}),
    });
}

function normalizeSession(session: McpSession): McpSession & {
  accountId: string;
  accounts: McpAccount[];
} {
  if (session.accounts?.length) {
    return {
      ...session,
      accountId: session.accountId ?? session.accounts[0]!.id,
      accounts: session.accounts,
    };
  }
  const account: McpAccount = {
    id: session.accountId ?? 'default',
    config: session.config,
    provider: session.provider,
    updater: session.updater,
    history: session.history,
    metrics: session.metrics,
    eventListeners: session.eventListeners,
  };
  return {
    ...session,
    accountId: account.id,
    accounts: [account],
  };
}

export type McpToolHandlers = {
  listProviders: () => Array<{ id: string; label: string }>;
  listAccounts: () => Array<{ id: string; provider: string; hosts: string[] }>;
  getPublicIp: (accountId?: string) => Promise<PublicIPDiscovery>;
  getConfig: (accountId?: string) => unknown;
  getAccountsConfig: () => { accounts: Array<{ id: string; config: unknown }> };
  checkOnce: (accountId?: string) => Promise<CheckResult | BusyCheckResult>;
  forceUpdate: (accountId?: string) => Promise<CheckResult | BusyCheckResult>;
  dryRun: (accountId?: string) => Promise<CheckResult | BusyCheckResult>;
  updateHosts: (
    hosts: string[],
    options?: { force?: boolean; dryRun?: boolean; accountId?: string },
  ) => Promise<CheckResult | BusyCheckResult>;
  getStatus: (accountId?: string) => UpdaterStatus;
  getAccountsStatus: () => { accounts: Array<{ id: string; status: UpdaterStatus }> };
  getHistory: (accountId?: string) => Promise<unknown>;
  getAccountsHistory: () => Promise<{ accounts: unknown[] }>;
  validateConfig: (accountId?: string) => {
    valid: boolean;
    provider: string;
    accountId: string;
    issues: ReturnType<typeof getProviderConfigIssues>;
  };
  explainLastCycle: (accountId?: string) => Promise<unknown>;
  setInterval: (
    intervalMs: number,
    accountId?: string,
  ) => UpdaterStatus | { accounts: Array<{ id: string; status: UpdaterStatus }> };
  startLoop: (
    accountId?: string,
  ) => Promise<UpdaterStatus | { accounts: Array<{ id: string; status: UpdaterStatus }> }>;
  stopLoop: (
    accountId?: string,
  ) => Promise<UpdaterStatus | { accounts: Array<{ id: string; status: UpdaterStatus }> }>;
};

export function createToolHandlers(
  session: McpSession,
  options: {
    discoverPublicIPFn?: () => Promise<PublicIPDiscovery>;
  } = {},
): McpToolHandlers {
  const normalized = normalizeSession(session);

  return {
    listProviders() {
      return listProviders().map(({ id, label }) => ({ id, label }));
    },

    listAccounts() {
      return normalized.accounts.map((account) => ({
        id: account.id,
        provider: account.provider.id,
        hosts: account.config.hosts,
      }));
    },

    async getPublicIp(accountId) {
      if (options.discoverPublicIPFn) {
        return await options.discoverPublicIPFn();
      }
      return await discoverFromConfig(getMcpAccount(normalized, accountId).config)();
    },

    getConfig(accountId) {
      return redact(getMcpAccount(normalized, accountId).config);
    },

    getAccountsConfig() {
      return {
        accounts: normalized.accounts.map((account) => ({
          id: account.id,
          config: redact(account.config),
        })),
      };
    },

    async checkOnce(accountId) {
      return await getMcpAccount(normalized, accountId).updater.checkOnceGuarded();
    },

    async forceUpdate(accountId) {
      return await getMcpAccount(normalized, accountId).updater.checkOnceGuarded({ force: true });
    },

    async dryRun(accountId) {
      return await getMcpAccount(normalized, accountId).updater.checkOnceGuarded({ dryRun: true });
    },

    async updateHosts(hosts, updateOptions = {}) {
      return await getMcpAccount(normalized, updateOptions.accountId).updater.checkOnceGuarded({
        hosts,
        ...(updateOptions.force ? { force: true } : {}),
        ...(updateOptions.dryRun ? { dryRun: true } : {}),
      });
    },

    getStatus(accountId) {
      return getMcpAccount(normalized, accountId).updater.getStatus();
    },

    getAccountsStatus() {
      return {
        accounts: normalized.accounts.map((account) => ({
          id: account.id,
          status: account.updater.getStatus(),
        })),
      };
    },

    async getHistory(accountId) {
      const account = getMcpAccount(normalized, accountId);
      const store = account.history ?? null;
      if (!store) {
        return { accountId: account.id, events: [] };
      }
      return { accountId: account.id, events: await store.load() };
    },

    async getAccountsHistory() {
      return {
        accounts: await Promise.all(
          normalized.accounts.map(async (account) => {
            const store = account.history ?? null;
            return {
              accountId: account.id,
              events: store ? await store.load() : [],
            };
          }),
        ),
      };
    },

    validateConfig(accountId) {
      const account = getMcpAccount(normalized, accountId);
      const issues = getProviderConfigIssues(account.config);
      return {
        valid: issues.length === 0,
        provider: account.config.provider,
        accountId: account.id,
        issues,
      };
    },

    async explainLastCycle(accountId) {
      const account = getMcpAccount(normalized, accountId);
      const status = account.updater.getStatus();
      const history = account.history ? await account.history.load() : [];
      const liveCycle = status.lastCycle;
      const cycle = liveCycle ?? history.at(-1) ?? null;
      if (!cycle) {
        return {
          accountId: account.id,
          summary: 'No updater cycle has completed yet',
          severity: 'info',
          nextSteps: ['Run check_once or dry_run'],
        };
      }
      const nextSteps =
        cycle.status === 'skipped_no_ip'
          ? ['Check outbound HTTPS and DNS access', 'Inspect IP discovery endpoints']
          : cycle.status === 'error' || cycle.status === 'partial'
            ? ['Check provider credentials and API reachability', 'Inspect failed host results']
            : cycle.status === 'dry_run'
              ? ['Review host results', 'Run update_hosts or check_once to apply changes']
              : ['No action required'];
      const failedHosts =
        liveCycle?.hostResults
          ?.filter(({ result }) => !result.ok)
          .map(({ host, result }) => ({ host, message: result.message })) ??
        ('failedHosts' in cycle && Array.isArray(cycle.failedHosts) ? cycle.failedHosts : []);
      return {
        accountId: account.id,
        summary: cycle.message,
        severity:
          cycle.status === 'error'
            ? 'error'
            : cycle.status === 'partial' || cycle.status === 'skipped_no_ip'
              ? 'warning'
              : 'info',
        status: cycle.status,
        at: cycle.at,
        discoveryErrors: cycle.discoveryErrors ?? null,
        failedHosts,
        nextSteps,
      };
    },

    setInterval(intervalMs, accountId) {
      if (!accountId && normalized.accounts.length > 1) {
        return {
          accounts: normalized.accounts.map((account) => {
            account.updater.setIntervalMs(intervalMs);
            return { id: account.id, status: account.updater.getStatus() };
          }),
        };
      }
      const account = getMcpAccount(normalized, accountId);
      account.updater.setIntervalMs(intervalMs);
      return account.updater.getStatus();
    },

    async startLoop(accountId) {
      if (!accountId && normalized.accounts.length > 1) {
        const accounts = [];
        for (const account of normalized.accounts) {
          await account.updater.start();
          accounts.push({ id: account.id, status: account.updater.getStatus() });
        }
        return { accounts };
      }
      const account = getMcpAccount(normalized, accountId);
      await account.updater.start();
      return account.updater.getStatus();
    },

    async stopLoop(accountId) {
      if (!accountId && normalized.accounts.length > 1) {
        const accounts = [];
        for (const account of normalized.accounts) {
          await account.updater.stop();
          accounts.push({ id: account.id, status: account.updater.getStatus() });
        }
        return { accounts };
      }
      const account = getMcpAccount(normalized, accountId);
      await account.updater.stop();
      return account.updater.getStatus();
    },
  };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
