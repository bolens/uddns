import { z } from 'zod';

import { resolveHosts } from '../hosts.js';
import { appConfigSchema, PROVIDER_IDS, providerIdSchema, type AppConfig } from './provider.js';

const optionalEnv = z.string().optional();
const envSchema = z
  .object({
    UDDNS_PROVIDER: optionalEnv,
    UDDNS_INTERVAL: optionalEnv,
    UDDNS_STATE_FILE: optionalEnv,
    UDDNS_LOG_LEVEL: optionalEnv,
    UDDNS_HOST: optionalEnv,
    UDDNS_HOSTNAME: optionalEnv,
    UDDNS_HOSTS: optionalEnv,
    UDDNS_USER: optionalEnv,
    UDDNS_PASS: optionalEnv,
    UDDNS_TOKEN: optionalEnv,
    CLOUDFLARE_API_TOKEN: optionalEnv,
    CLOUDFLARE_ZONE_ID: optionalEnv,
    CLOUDFLARE_ZONE_NAME: optionalEnv,
    CLOUDFLARE_RECORD_NAME: optionalEnv,
    CLOUDFLARE_RECORD_ID: optionalEnv,
    CLOUDFLARE_PROXIED: optionalEnv,
    CLOUDFLARE_TTL: optionalEnv,
    CLOUDFLARE_CREATE_IF_MISSING: optionalEnv,
    DUCKDNS_DOMAINS: optionalEnv,
    DUCKDNS_TOKEN: optionalEnv,
    NAMECHEAP_HOST: optionalEnv,
    NAMECHEAP_DOMAIN: optionalEnv,
    NAMECHEAP_PASSWORD: optionalEnv,
    DYNDNS_UPDATE_URL: optionalEnv,
  })
  .passthrough();

const MANAGED_ENV_PREFIXES = ['UDDNS_', 'CLOUDFLARE_', 'DUCKDNS_', 'NAMECHEAP_', 'DYNDNS_'];
const KNOWN_ENV_KEYS = new Set(Object.keys(envSchema.shape));

function rejectUnknownManagedEnv(env: Record<string, string | undefined>): void {
  const unknown = Object.keys(env).filter(
    (key) =>
      MANAGED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) && !KNOWN_ENV_KEYS.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown uDDNS environment variable(s): ${unknown.sort().join(', ')}`);
  }
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Load and validate runtime configuration from environment variables.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppConfig {
  rejectUnknownManagedEnv(env);
  const parsedEnv = envSchema.parse({ ...env });

  const providerRaw = (parsedEnv['UDDNS_PROVIDER'] ?? 'cloudflare').toLowerCase();

  const providerResult = providerIdSchema.safeParse(providerRaw);
  if (!providerResult.success) {
    throw new Error(
      `Unsupported UDDNS_PROVIDER "${providerRaw}". Supported: ${PROVIDER_IDS.join(', ')}`,
    );
  }

  const interval = Number(parsedEnv['UDDNS_INTERVAL'] ?? 900_000);

  if (!Number.isFinite(interval) || interval < 1_000) {
    throw new Error('UDDNS_INTERVAL must be a number of milliseconds >= 1000');
  }

  const hostname = parsedEnv['UDDNS_HOST'] ?? parsedEnv['UDDNS_HOSTNAME'] ?? null;
  const hosts = resolveHosts({
    hosts: parsedEnv['UDDNS_HOSTS'] ?? null,
    host: hostname,
    cloudflareRecordName: parsedEnv['CLOUDFLARE_RECORD_NAME'] ?? null,
    duckdnsDomains: parsedEnv['DUCKDNS_DOMAINS'] ?? null,
    namecheapHost: parsedEnv['NAMECHEAP_HOST'] ?? null,
    namecheapDomain: parsedEnv['NAMECHEAP_DOMAIN'] ?? null,
  });

  if (hosts.length === 0) {
    throw new Error('No hosts configured. Set UDDNS_HOSTS (comma-separated) or UDDNS_HOST.');
  }
  for (const host of hosts) {
    if (!isValidHostname(host)) {
      throw new Error(`Invalid hostname in uDDNS configuration: "${host}"`);
    }
  }

  const firstHost = hosts[0] ?? null;

  const dyndnsUpdateUrl = parsedEnv['DYNDNS_UPDATE_URL'] ?? 'https://members.dyndns.org/nic/update';
  if (!isHttpsUrl(dyndnsUpdateUrl)) {
    throw new Error(
      'DYNDNS_UPDATE_URL must be a valid https:// URL (credentials would travel in cleartext over http)',
    );
  }

  const config = {
    provider: providerResult.data,
    interval,
    stateFile:
      parsedEnv['UDDNS_STATE_FILE'] === ''
        ? null
        : (parsedEnv['UDDNS_STATE_FILE'] ?? '.uddns-state.json'),
    hosts,
    hostname: firstHost,
    user: parsedEnv['UDDNS_USER'] ?? null,
    password: parsedEnv['UDDNS_PASS'] ?? null,
    token:
      parsedEnv['UDDNS_TOKEN'] ??
      parsedEnv['CLOUDFLARE_API_TOKEN'] ??
      parsedEnv['DUCKDNS_TOKEN'] ??
      null,
    cloudflare: {
      apiToken: parsedEnv['CLOUDFLARE_API_TOKEN'] ?? parsedEnv['UDDNS_TOKEN'] ?? null,
      zoneId: parsedEnv['CLOUDFLARE_ZONE_ID'] ?? null,
      zoneName: parsedEnv['CLOUDFLARE_ZONE_NAME'] ?? null,
      recordName: parsedEnv['CLOUDFLARE_RECORD_NAME'] ?? firstHost,
      recordId: hosts.length === 1 ? (parsedEnv['CLOUDFLARE_RECORD_ID'] ?? null) : null,
      proxied: parseBoolean('CLOUDFLARE_PROXIED', parsedEnv['CLOUDFLARE_PROXIED'], false),
      ttl: Number(parsedEnv['CLOUDFLARE_TTL'] ?? 1),
      createIfMissing: parseBoolean(
        'CLOUDFLARE_CREATE_IF_MISSING',
        parsedEnv['CLOUDFLARE_CREATE_IF_MISSING'],
        true,
      ),
    },
    duckdns: {
      domains: parsedEnv['DUCKDNS_DOMAINS'] ?? hosts.join(',') ?? null,
      token: parsedEnv['DUCKDNS_TOKEN'] ?? parsedEnv['UDDNS_TOKEN'] ?? null,
    },
    namecheap: {
      host: parsedEnv['NAMECHEAP_HOST'] ?? '@',
      domain: parsedEnv['NAMECHEAP_DOMAIN'] ?? null,
      password: parsedEnv['NAMECHEAP_PASSWORD'] ?? parsedEnv['UDDNS_PASS'] ?? null,
    },
    dyndns: {
      updateUrl: dyndnsUpdateUrl,
      username: parsedEnv['UDDNS_USER'] ?? null,
      password: parsedEnv['UDDNS_PASS'] ?? null,
      hostname: firstHost,
    },
  };

  const parsedConfig = appConfigSchema.parse(config);
  validateProviderConfig(parsedConfig);
  return parsedConfig;
}

function isValidHostname(value: string): boolean {
  if (value.length > 253 || value.startsWith('.') || value.endsWith('.')) {
    return false;
  }
  return value
    .split('.')
    .every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

export function validateProviderConfig(config: AppConfig): void {
  const missing: string[] = [];

  switch (config.provider) {
    case 'cloudflare':
      if (!config.cloudflare.apiToken) missing.push('CLOUDFLARE_API_TOKEN');
      if (!config.cloudflare.recordName) missing.push('CLOUDFLARE_RECORD_NAME or UDDNS_HOST(S)');
      break;
    case 'duckdns':
      if (!config.duckdns.token) missing.push('DUCKDNS_TOKEN');
      if (!config.duckdns.domains) missing.push('DUCKDNS_DOMAINS or UDDNS_HOST(S)');
      break;
    case 'namecheap':
      if (!config.namecheap.password) missing.push('NAMECHEAP_PASSWORD');
      if (!config.namecheap.domain && config.hosts.some((host) => !host.includes('.'))) {
        missing.push('NAMECHEAP_DOMAIN (required when hosts are not FQDNs)');
      }
      break;
    case 'noip':
    case 'dynu':
    case 'dyndns':
      if (!config.dyndns.username) missing.push('UDDNS_USER');
      if (!config.dyndns.password) missing.push('UDDNS_PASS');
      if (!config.dyndns.hostname) missing.push('UDDNS_HOST(S)');
      break;
  }

  if (missing.length > 0) {
    throw new Error(`Invalid ${config.provider} configuration; missing: ${missing.join(', ')}`);
  }
}

export type { AppConfig };
