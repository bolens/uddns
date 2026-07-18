/**
 * Multi-account YAML configuration loader.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { loadConfig, MANAGED_ENV_PREFIXES } from './config.js';
import { normalizeDnsName } from './providers/domain-host.js';
import type { AppConfig, Provider } from './schemas/provider.js';

const accountYamlSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
  })
  .passthrough();

const configFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountYamlSchema).min(1),
});

export type AccountRole = 'primary' | 'failover';

export type LoadedAccount = {
  id: string;
  config: AppConfig;
  role: AccountRole;
  failoverAccountIds: string[];
};

export type FailoverTarget = {
  accountId: string;
  provider: Provider;
  config: AppConfig;
};

/** Process-level knobs that should apply to every YAML account. */
const PASSTHROUGH_ENV_KEYS = new Set(['UDDNS_DATA_DIR', 'DYNDNS_UPDATE_URL_ALLOW_HOSTS']);

/** Drop managed uDDNS/provider keys so YAML accounts cannot inherit process env bleed. */
function scrubManagedEnv(
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      PASSTHROUGH_ENV_KEYS.has(key) ||
      !MANAGED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

function parseAccountRole(value: unknown): AccountRole {
  if (value == null || value === '') {
    return 'primary';
  }
  if (value === 'primary' || value === 'failover') {
    return value;
  }
  throw new Error(
    `Account role must be "primary" or "failover" (got ${typeof value === 'string' ? value : JSON.stringify(value)})`,
  );
}

function parseFailoverIds(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error('failover entries must be non-empty account id strings');
      }
      return entry.trim();
    });
  }
  throw new Error('failover must be a list of account ids or a comma-separated string');
}

function accountToEnv(
  accountId: string,
  account: Record<string, unknown>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = scrubManagedEnv(baseEnv);
  const set = (key: string, value: unknown) => {
    if (value === undefined) {
      return;
    }
    if (value === null) {
      delete env[key];
      return;
    }
    env[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  };
  const setList = (key: string, value: unknown) => {
    if (value === undefined || value === null) {
      return;
    }
    set(key, Array.isArray(value) ? value.join(',') : value);
  };

  set('UDDNS_PROVIDER', account['provider']);
  set('UDDNS_INTERVAL', account['interval']);
  set('UDDNS_STATE_FILE', account['stateFile'] ?? account['state_file']);
  set('UDDNS_HISTORY_FILE', account['historyFile'] ?? account['history_file']);
  setList('UDDNS_HOSTS', account['hosts']);
  const disabledHosts = account['disabledHosts'] ?? account['disabled_hosts'];
  setList('UDDNS_DISABLED_HOSTS', disabledHosts);
  set('UDDNS_HOST', account['host'] ?? account['hostname']);
  set('UDDNS_USER', account['user']);
  set('UDDNS_PASS', account['password'] ?? account['pass']);
  set('UDDNS_TOKEN', account['token']);
  set('UDDNS_IP_FAMILY', account['ipFamily'] ?? account['ip_family']);
  set('UDDNS_IP_MISSING', account['ipMissing'] ?? account['ip_missing']);
  setList('UDDNS_IP_HTTPS_V4', account['ipHttpsV4'] ?? account['ip_https_v4']);
  setList('UDDNS_IP_HTTPS_V6', account['ipHttpsV6'] ?? account['ip_https_v6']);
  set('UDDNS_IP_TIMEOUT_MS', account['ipTimeoutMs'] ?? account['ip_timeout_ms']);
  set('UDDNS_IP_DNS_FALLBACK', account['ipDnsFallback'] ?? account['ip_dns_fallback']);
  set('UDDNS_OTEL', account['telemetryEnabled'] ?? account['telemetry_enabled']);

  const retry = account['retry'];
  if (retry && typeof retry === 'object') {
    const value = retry as Record<string, unknown>;
    set('UDDNS_RETRY_ATTEMPTS', value['attempts']);
    set('UDDNS_RETRY_BASE_DELAY_MS', value['baseDelayMs'] ?? value['base_delay_ms']);
    set('UDDNS_RETRY_MAX_DELAY_MS', value['maxDelayMs'] ?? value['max_delay_ms']);
  }

  const notify = account['notify'];
  if (notify && typeof notify === 'object') {
    const value = notify as Record<string, unknown>;
    set('UDDNS_NOTIFY_WEBHOOK_URL', value['webhookUrl'] ?? value['webhook_url']);
    set('UDDNS_NOTIFY_NTFY_URL', value['ntfyUrl'] ?? value['ntfy_url']);
    set('UDDNS_NOTIFY_SLACK_URL', value['slackUrl'] ?? value['slack_url']);
    set('UDDNS_NOTIFY_DISCORD_URL', value['discordUrl'] ?? value['discord_url']);
    set('UDDNS_NOTIFY_ON', Array.isArray(value['on']) ? value['on'].join(',') : value['on']);
  }

  const cloudflare = account['cloudflare'];
  if (cloudflare && typeof cloudflare === 'object') {
    const cf = cloudflare as Record<string, unknown>;
    set('CLOUDFLARE_API_TOKEN', cf['apiToken'] ?? cf['api_token']);
    set('CLOUDFLARE_ZONE_ID', cf['zoneId'] ?? cf['zone_id']);
    set('CLOUDFLARE_ZONE_NAME', cf['zoneName'] ?? cf['zone_name']);
    set('CLOUDFLARE_RECORD_NAME', cf['recordName'] ?? cf['record_name']);
    set('CLOUDFLARE_RECORD_ID', cf['recordId'] ?? cf['record_id']);
    set('CLOUDFLARE_PROXIED', cf['proxied']);
    set('CLOUDFLARE_TTL', cf['ttl']);
    set('CLOUDFLARE_CREATE_IF_MISSING', cf['createIfMissing'] ?? cf['create_if_missing']);
  }

  const duckdns = account['duckdns'];
  if (duckdns && typeof duckdns === 'object') {
    const dd = duckdns as Record<string, unknown>;
    set('DUCKDNS_TOKEN', dd['token']);
    setList('DUCKDNS_DOMAINS', dd['domains']);
  }

  const namecheap = account['namecheap'];
  if (namecheap && typeof namecheap === 'object') {
    const nc = namecheap as Record<string, unknown>;
    set('NAMECHEAP_HOST', nc['host']);
    set('NAMECHEAP_DOMAIN', nc['domain']);
    set('NAMECHEAP_PASSWORD', nc['password']);
  }

  const dyndns = account['dyndns'];
  if (dyndns && typeof dyndns === 'object') {
    const dn = dyndns as Record<string, unknown>;
    set('DYNDNS_UPDATE_URL', dn['updateUrl'] ?? dn['update_url']);
    set('UDDNS_USER', dn['username'] ?? env['UDDNS_USER']);
    set('UDDNS_PASS', dn['password'] ?? env['UDDNS_PASS']);
  }

  const route53 = account['route53'];
  if (route53 && typeof route53 === 'object') {
    const r53 = route53 as Record<string, unknown>;
    set('ROUTE53_ACCESS_KEY_ID', r53['accessKeyId'] ?? r53['access_key_id']);
    set('ROUTE53_SECRET_ACCESS_KEY', r53['secretAccessKey'] ?? r53['secret_access_key']);
    set('ROUTE53_REGION', r53['region']);
    set('ROUTE53_HOSTED_ZONE_ID', r53['hostedZoneId'] ?? r53['hosted_zone_id']);
    set('ROUTE53_TTL', r53['ttl']);
    set('ROUTE53_CREATE_IF_MISSING', r53['createIfMissing'] ?? r53['create_if_missing']);
  }

  const porkbun = account['porkbun'];
  if (porkbun && typeof porkbun === 'object') {
    const pb = porkbun as Record<string, unknown>;
    set('PORKBUN_API_KEY', pb['apiKey'] ?? pb['api_key']);
    set('PORKBUN_SECRET_KEY', pb['secretKey'] ?? pb['secret_key']);
    set('PORKBUN_DOMAIN', pb['domain']);
  }

  const hetzner = account['hetzner'];
  if (hetzner && typeof hetzner === 'object') {
    const hz = hetzner as Record<string, unknown>;
    set('HETZNER_API_TOKEN', hz['apiToken'] ?? hz['api_token']);
    set('HETZNER_ZONE_ID', hz['zoneId'] ?? hz['zone_id']);
    set('HETZNER_ZONE_NAME', hz['zoneName'] ?? hz['zone_name']);
  }

  const digitalocean = account['digitalocean'];
  if (digitalocean && typeof digitalocean === 'object') {
    const dig = digitalocean as Record<string, unknown>;
    set('DIGITALOCEAN_API_TOKEN', dig['apiToken'] ?? dig['api_token']);
    set('DIGITALOCEAN_DOMAIN', dig['domain']);
  }

  for (const [name, mappings] of Object.entries({
    gandi: {
      GANDI_API_TOKEN: 'apiToken',
      GANDI_DOMAIN: 'domain',
      GANDI_TTL: 'ttl',
    },
    linode: {
      LINODE_API_TOKEN: 'apiToken',
      LINODE_DOMAIN_ID: 'domainId',
      LINODE_DOMAIN: 'domain',
      LINODE_TTL: 'ttl',
    },
    ovh: {
      OVH_ENDPOINT: 'endpoint',
      OVH_APPLICATION_KEY: 'applicationKey',
      OVH_APPLICATION_SECRET: 'applicationSecret',
      OVH_CONSUMER_KEY: 'consumerKey',
      OVH_ZONE: 'zone',
      OVH_TTL: 'ttl',
    },
    bunny: {
      BUNNY_API_KEY: 'apiKey',
      BUNNY_ZONE_ID: 'zoneId',
      BUNNY_DOMAIN: 'domain',
      BUNNY_TTL: 'ttl',
    },
    contabo: {
      CONTABO_CLIENT_ID: 'clientId',
      CONTABO_CLIENT_SECRET: 'clientSecret',
      CONTABO_API_USER: 'apiUser',
      CONTABO_API_PASSWORD: 'apiPassword',
      CONTABO_ZONE: 'zone',
      CONTABO_TTL: 'ttl',
    },
  })) {
    const section = account[name];
    if (!section || typeof section !== 'object') continue;
    const values = section as Record<string, unknown>;
    for (const [envKey, property] of Object.entries(mappings)) {
      const snake = property.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      set(envKey, values[property] ?? values[snake]);
    }
  }

  // Per-account state/history defaults derived from id when unset.
  if (env['UDDNS_STATE_FILE'] == null || env['UDDNS_STATE_FILE'] === '') {
    if (account['stateFile'] == null && account['state_file'] == null) {
      env['UDDNS_STATE_FILE'] = `.uddns-state-${accountId}.json`;
    }
  }
  if (env['UDDNS_HISTORY_FILE'] == null || env['UDDNS_HISTORY_FILE'] === '') {
    if (account['historyFile'] == null && account['history_file'] == null) {
      env['UDDNS_HISTORY_FILE'] = `.uddns-history-${accountId}.json`;
    }
  }

  return env;
}

function assertUniqueAccountIds(accounts: Array<{ id: string }>): void {
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new Error(`Duplicate account id "${account.id}"`);
    }
    seen.add(account.id);
  }
}

function assertUniqueAccountPaths(accounts: LoadedAccount[]): void {
  if (accounts.length <= 1) {
    return;
  }
  const stateOwners = new Map<string, string>();
  const historyOwners = new Map<string, string>();
  for (const account of accounts) {
    const stateFile = account.config.stateFile;
    if (stateFile) {
      const key = path.resolve(stateFile);
      const owner = stateOwners.get(key);
      if (owner) {
        throw new Error(`Accounts "${owner}" and "${account.id}" share stateFile "${stateFile}"`);
      }
      stateOwners.set(key, account.id);
    }
    const historyFile = account.config.historyFile;
    if (historyFile) {
      const key = path.resolve(historyFile);
      const owner = historyOwners.get(key);
      if (owner) {
        throw new Error(
          `Accounts "${owner}" and "${account.id}" share historyFile "${historyFile}"`,
        );
      }
      historyOwners.set(key, account.id);
    }
  }
}

function assertFailoverGraph(accounts: LoadedAccount[]): void {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const account of accounts) {
    if (account.role === 'failover') {
      if (account.failoverAccountIds.length > 0) {
        throw new Error(
          `Failover account "${account.id}" cannot declare failover targets (flat chains only)`,
        );
      }
      continue;
    }
    const primaryHosts = new Set(account.config.hosts.map(normalizeDnsName));
    for (const targetId of account.failoverAccountIds) {
      const target = byId.get(targetId);
      if (!target) {
        throw new Error(
          `Account "${account.id}" references unknown failover account "${targetId}"`,
        );
      }
      if (target.role !== 'failover') {
        throw new Error(
          `Account "${account.id}" failover target "${targetId}" must have role: failover`,
        );
      }
      const shared = target.config.hosts.some((host) => primaryHosts.has(normalizeDnsName(host)));
      if (!shared) {
        throw new Error(
          `Account "${account.id}" and failover "${targetId}" must share at least one host`,
        );
      }
    }
  }
}

/** Accounts that run their own updater loop (excludes standby failover targets). */
export function runnableAccounts(accounts: LoadedAccount[]): LoadedAccount[] {
  return accounts.filter((account) => account.role !== 'failover');
}

export function resolveFailoverTargets(
  account: LoadedAccount,
  allAccounts: LoadedAccount[],
  getProviderFn: (id: string) => Provider,
): FailoverTarget[] {
  const byId = new Map(allAccounts.map((entry) => [entry.id, entry]));
  return account.failoverAccountIds.map((targetId) => {
    const target = byId.get(targetId);
    if (!target) {
      throw new Error(`Unknown failover account "${targetId}" for "${account.id}"`);
    }
    return {
      accountId: target.id,
      provider: getProviderFn(target.config.provider),
      config: target.config,
    };
  });
}

export async function loadAccountsFromFile(
  filePath: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<LoadedAccount[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = configFileSchema.parse(parseYaml(raw));
  assertUniqueAccountIds(parsed.accounts);
  const configDir = path.dirname(path.resolve(filePath));
  const accounts = parsed.accounts.map((account) => {
    const { id, ...rest } = account;
    const role = parseAccountRole(rest['role']);
    const failoverAccountIds = parseFailoverIds(rest['failover']);
    const env = accountToEnv(
      id,
      rest as Record<string, unknown>,
      baseEnv as Record<string, string | undefined>,
    );
    // Avoid recursive multi-file loading.
    delete env['UDDNS_CONFIG_FILE'];
    // Default data root to the YAML directory so relative state/history stay local.
    if (env['UDDNS_DATA_DIR'] == null || env['UDDNS_DATA_DIR'] === '') {
      env['UDDNS_DATA_DIR'] = configDir;
    }
    return { id, config: loadConfig(env), role, failoverAccountIds };
  });
  assertUniqueAccountPaths(accounts);
  assertFailoverGraph(accounts);
  return accounts;
}

export function resolveAccounts(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<LoadedAccount[]> | LoadedAccount[] {
  const file = env['UDDNS_CONFIG_FILE']?.trim();
  if (file) {
    return loadAccountsFromFile(file, env);
  }
  return [{ id: 'default', config: loadConfig(env), role: 'primary', failoverAccountIds: [] }];
}
