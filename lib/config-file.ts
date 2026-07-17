/**
 * Multi-account YAML configuration loader.
 */

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { loadConfig } from './config.js';
import type { AppConfig } from './schemas/provider.js';

const accountYamlSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const configFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountYamlSchema).min(1),
});

export type LoadedAccount = {
  id: string;
  config: AppConfig;
};

function accountToEnv(
  accountId: string,
  account: Record<string, unknown>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) {
      return;
    }
    env[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  };

  set('UDDNS_PROVIDER', account['provider']);
  set('UDDNS_INTERVAL', account['interval']);
  set('UDDNS_STATE_FILE', account['stateFile'] ?? account['state_file']);
  set('UDDNS_HISTORY_FILE', account['historyFile'] ?? account['history_file']);
  set(
    'UDDNS_HOSTS',
    Array.isArray(account['hosts']) ? account['hosts'].join(',') : account['hosts'],
  );
  const disabledHosts = account['disabledHosts'] ?? account['disabled_hosts'];
  set(
    'UDDNS_DISABLED_HOSTS',
    Array.isArray(disabledHosts) ? disabledHosts.join(',') : disabledHosts,
  );
  set('UDDNS_HOST', account['host'] ?? account['hostname']);
  set('UDDNS_USER', account['user']);
  set('UDDNS_PASS', account['password'] ?? account['pass']);
  set('UDDNS_TOKEN', account['token']);
  set('UDDNS_IP_FAMILY', account['ipFamily'] ?? account['ip_family']);
  set('UDDNS_IP_MISSING', account['ipMissing'] ?? account['ip_missing']);
  set('UDDNS_OTEL', account['telemetryEnabled'] ?? account['telemetry_enabled']);

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
    set('CLOUDFLARE_PROXIED', cf['proxied']);
    set('CLOUDFLARE_TTL', cf['ttl']);
    set('CLOUDFLARE_CREATE_IF_MISSING', cf['createIfMissing'] ?? cf['create_if_missing']);
  }

  const duckdns = account['duckdns'];
  if (duckdns && typeof duckdns === 'object') {
    const dd = duckdns as Record<string, unknown>;
    set('DUCKDNS_TOKEN', dd['token']);
    set('DUCKDNS_DOMAINS', dd['domains']);
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

function assertUniqueAccountPaths(accounts: LoadedAccount[]): void {
  if (accounts.length <= 1) {
    return;
  }
  const stateOwners = new Map<string, string>();
  const historyOwners = new Map<string, string>();
  for (const account of accounts) {
    const stateFile = account.config.stateFile;
    if (stateFile) {
      const owner = stateOwners.get(stateFile);
      if (owner) {
        throw new Error(`Accounts "${owner}" and "${account.id}" share stateFile "${stateFile}"`);
      }
      stateOwners.set(stateFile, account.id);
    }
    const historyFile = account.config.historyFile;
    if (historyFile) {
      const owner = historyOwners.get(historyFile);
      if (owner) {
        throw new Error(
          `Accounts "${owner}" and "${account.id}" share historyFile "${historyFile}"`,
        );
      }
      historyOwners.set(historyFile, account.id);
    }
  }
}

export async function loadAccountsFromFile(
  filePath: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<LoadedAccount[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = configFileSchema.parse(parseYaml(raw));
  const accounts = parsed.accounts.map((account) => {
    const { id, ...rest } = account;
    const env = accountToEnv(
      id,
      rest as Record<string, unknown>,
      baseEnv as Record<string, string | undefined>,
    );
    // Avoid recursive multi-file loading.
    delete env['UDDNS_CONFIG_FILE'];
    return { id, config: loadConfig(env) };
  });
  assertUniqueAccountPaths(accounts);
  return accounts;
}

export function resolveAccounts(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<LoadedAccount[]> | LoadedAccount[] {
  const file = env['UDDNS_CONFIG_FILE']?.trim();
  if (file) {
    return loadAccountsFromFile(file, env);
  }
  return [{ id: 'default', config: loadConfig(env) }];
}
