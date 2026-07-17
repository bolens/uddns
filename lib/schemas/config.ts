import { z } from 'zod';

import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DYNDNS_UPDATE_URL,
  DEFAULT_HISTORY_FILE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_IP_DNS_FALLBACK,
  DEFAULT_IP_FAMILY,
  DEFAULT_IP_MISSING,
  DEFAULT_IP_TIMEOUT_MS,
  DEFAULT_NAMECHEAP_HOST,
  DEFAULT_NOTIFY_ON,
  DEFAULT_PROVIDER,
  DEFAULT_ROUTE53_REGION,
  DEFAULT_ROUTE53_TTL,
  DEFAULT_STATE_FILE,
} from '../defaults.js';
import { resolveHosts } from '../hosts.js';
import { parseIpFamily, parseIpMissing } from '../ip-policy.js';
import { appConfigSchema, PROVIDER_IDS, providerIdSchema, type AppConfig } from './provider.js';

const optionalEnv = z.string().optional();
const envSchema = z
  .object({
    UDDNS_PROVIDER: optionalEnv,
    UDDNS_INTERVAL: optionalEnv,
    UDDNS_STATE_FILE: optionalEnv,
    UDDNS_HISTORY_FILE: optionalEnv,
    UDDNS_LOG_LEVEL: optionalEnv,
    UDDNS_LOG_FORMAT: optionalEnv,
    UDDNS_HOST: optionalEnv,
    UDDNS_HOSTNAME: optionalEnv,
    UDDNS_HOSTS: optionalEnv,
    UDDNS_USER: optionalEnv,
    UDDNS_PASS: optionalEnv,
    UDDNS_TOKEN: optionalEnv,
    UDDNS_IP_FAMILY: optionalEnv,
    UDDNS_IP_MISSING: optionalEnv,
    UDDNS_IP_HTTPS_V4: optionalEnv,
    UDDNS_IP_HTTPS_V6: optionalEnv,
    UDDNS_IP_DNS_FALLBACK: optionalEnv,
    UDDNS_IP_TIMEOUT_MS: optionalEnv,
    UDDNS_NOTIFY_WEBHOOK_URL: optionalEnv,
    UDDNS_NOTIFY_NTFY_URL: optionalEnv,
    UDDNS_NOTIFY_ON: optionalEnv,
    UDDNS_HEALTH: optionalEnv,
    UDDNS_HEALTH_HOST: optionalEnv,
    UDDNS_HEALTH_PORT: optionalEnv,
    UDDNS_METRICS: optionalEnv,
    UDDNS_CONFIG_FILE: optionalEnv,
    UDDNS_MCP_TRANSPORT: optionalEnv,
    UDDNS_MCP_HOST: optionalEnv,
    UDDNS_MCP_PORT: optionalEnv,
    UDDNS_MCP_AUTH_TOKEN: optionalEnv,
    UDDNS_MCP_TLS_CERT: optionalEnv,
    UDDNS_MCP_TLS_KEY: optionalEnv,
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
    ROUTE53_ACCESS_KEY_ID: optionalEnv,
    ROUTE53_SECRET_ACCESS_KEY: optionalEnv,
    ROUTE53_REGION: optionalEnv,
    ROUTE53_HOSTED_ZONE_ID: optionalEnv,
    ROUTE53_TTL: optionalEnv,
    ROUTE53_CREATE_IF_MISSING: optionalEnv,
    PORKBUN_API_KEY: optionalEnv,
    PORKBUN_SECRET_KEY: optionalEnv,
    PORKBUN_DOMAIN: optionalEnv,
    HETZNER_API_TOKEN: optionalEnv,
    HETZNER_ZONE_ID: optionalEnv,
    HETZNER_ZONE_NAME: optionalEnv,
    DIGITALOCEAN_API_TOKEN: optionalEnv,
    DIGITALOCEAN_DOMAIN: optionalEnv,
  })
  .passthrough();

const MANAGED_ENV_PREFIXES = [
  'UDDNS_',
  'CLOUDFLARE_',
  'DUCKDNS_',
  'NAMECHEAP_',
  'DYNDNS_',
  'ROUTE53_',
  'PORKBUN_',
  'HETZNER_',
  'DIGITALOCEAN_',
];
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

  const providerRaw = (parsedEnv['UDDNS_PROVIDER'] ?? DEFAULT_PROVIDER).toLowerCase();

  const providerResult = providerIdSchema.safeParse(providerRaw);
  if (!providerResult.success) {
    throw new Error(
      `Unsupported UDDNS_PROVIDER "${providerRaw}". Supported: ${PROVIDER_IDS.join(', ')}`,
    );
  }

  const interval = Number(parsedEnv['UDDNS_INTERVAL'] ?? DEFAULT_INTERVAL_MS);

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

  const dyndnsUpdateUrl = parsedEnv['DYNDNS_UPDATE_URL'] ?? DEFAULT_DYNDNS_UPDATE_URL;
  if (!isHttpsUrl(dyndnsUpdateUrl)) {
    throw new Error(
      'DYNDNS_UPDATE_URL must be a valid https:// URL (credentials would travel in cleartext over http)',
    );
  }

  const ipTimeoutMs = Number(parsedEnv['UDDNS_IP_TIMEOUT_MS'] ?? DEFAULT_IP_TIMEOUT_MS);
  if (!Number.isFinite(ipTimeoutMs) || ipTimeoutMs < 100 || ipTimeoutMs > 120_000) {
    throw new Error('UDDNS_IP_TIMEOUT_MS must be an integer from 100 to 120000');
  }

  const notifyOnRaw = (parsedEnv['UDDNS_NOTIFY_ON'] ?? DEFAULT_NOTIFY_ON.join(',')).trim();
  const notifyOn = notifyOnRaw
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (notifyOn.length === 0 || notifyOn.some((part) => part !== 'change' && part !== 'error')) {
    throw new Error('UDDNS_NOTIFY_ON must be a comma-separated list of: change, error');
  }

  const webhookUrl = parsedEnv['UDDNS_NOTIFY_WEBHOOK_URL']?.trim() || null;
  if (webhookUrl && !isHttpsUrl(webhookUrl)) {
    throw new Error('UDDNS_NOTIFY_WEBHOOK_URL must be a valid https:// URL');
  }
  const ntfyUrl = parsedEnv['UDDNS_NOTIFY_NTFY_URL']?.trim() || null;
  if (ntfyUrl && !isHttpsUrl(ntfyUrl)) {
    throw new Error('UDDNS_NOTIFY_NTFY_URL must be a valid https:// URL');
  }

  const config = {
    provider: providerResult.data,
    interval,
    stateFile:
      parsedEnv['UDDNS_STATE_FILE'] === ''
        ? null
        : (parsedEnv['UDDNS_STATE_FILE'] ?? DEFAULT_STATE_FILE),
    historyFile:
      parsedEnv['UDDNS_HISTORY_FILE'] === ''
        ? null
        : (parsedEnv['UDDNS_HISTORY_FILE'] ?? DEFAULT_HISTORY_FILE),
    hosts,
    hostname: firstHost,
    user: parsedEnv['UDDNS_USER'] ?? null,
    password: parsedEnv['UDDNS_PASS'] ?? null,
    token:
      parsedEnv['UDDNS_TOKEN'] ??
      parsedEnv['CLOUDFLARE_API_TOKEN'] ??
      parsedEnv['DUCKDNS_TOKEN'] ??
      null,
    ipFamily: parseIpFamily(parsedEnv['UDDNS_IP_FAMILY'] ?? DEFAULT_IP_FAMILY),
    ipMissing: parseIpMissing(parsedEnv['UDDNS_IP_MISSING'] ?? DEFAULT_IP_MISSING),
    ipHttpsV4: parseUrlList(parsedEnv['UDDNS_IP_HTTPS_V4']),
    ipHttpsV6: parseUrlList(parsedEnv['UDDNS_IP_HTTPS_V6']),
    ipDnsFallback: parseBoolean(
      'UDDNS_IP_DNS_FALLBACK',
      parsedEnv['UDDNS_IP_DNS_FALLBACK'],
      DEFAULT_IP_DNS_FALLBACK,
    ),
    ipTimeoutMs,
    notifyWebhookUrl: webhookUrl,
    notifyNtfyUrl: ntfyUrl,
    notifyOn: notifyOn as Array<'change' | 'error'>,
    cloudflare: {
      apiToken: parsedEnv['CLOUDFLARE_API_TOKEN'] ?? parsedEnv['UDDNS_TOKEN'] ?? null,
      zoneId: parsedEnv['CLOUDFLARE_ZONE_ID'] ?? null,
      zoneName: parsedEnv['CLOUDFLARE_ZONE_NAME'] ?? null,
      recordName: parsedEnv['CLOUDFLARE_RECORD_NAME'] ?? firstHost,
      recordId: hosts.length === 1 ? (parsedEnv['CLOUDFLARE_RECORD_ID'] ?? null) : null,
      proxied: parseBoolean('CLOUDFLARE_PROXIED', parsedEnv['CLOUDFLARE_PROXIED'], false),
      ttl: Number(parsedEnv['CLOUDFLARE_TTL'] ?? DEFAULT_CLOUDFLARE_TTL),
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
      host: parsedEnv['NAMECHEAP_HOST'] ?? DEFAULT_NAMECHEAP_HOST,
      domain: parsedEnv['NAMECHEAP_DOMAIN'] ?? null,
      password: parsedEnv['NAMECHEAP_PASSWORD'] ?? parsedEnv['UDDNS_PASS'] ?? null,
    },
    dyndns: {
      updateUrl: dyndnsUpdateUrl,
      username: parsedEnv['UDDNS_USER'] ?? null,
      password: parsedEnv['UDDNS_PASS'] ?? null,
      hostname: firstHost,
    },
    route53: {
      accessKeyId: parsedEnv['ROUTE53_ACCESS_KEY_ID'] ?? null,
      secretAccessKey: parsedEnv['ROUTE53_SECRET_ACCESS_KEY'] ?? null,
      region: parsedEnv['ROUTE53_REGION'] ?? DEFAULT_ROUTE53_REGION,
      hostedZoneId: parsedEnv['ROUTE53_HOSTED_ZONE_ID'] ?? null,
      ttl: Number(parsedEnv['ROUTE53_TTL'] ?? DEFAULT_ROUTE53_TTL),
      createIfMissing: parseBoolean(
        'ROUTE53_CREATE_IF_MISSING',
        parsedEnv['ROUTE53_CREATE_IF_MISSING'],
        true,
      ),
    },
    porkbun: {
      apiKey: parsedEnv['PORKBUN_API_KEY'] ?? null,
      secretKey: parsedEnv['PORKBUN_SECRET_KEY'] ?? null,
      domain: parsedEnv['PORKBUN_DOMAIN'] ?? null,
    },
    hetzner: {
      apiToken: parsedEnv['HETZNER_API_TOKEN'] ?? null,
      zoneId: parsedEnv['HETZNER_ZONE_ID'] ?? null,
      zoneName: parsedEnv['HETZNER_ZONE_NAME'] ?? null,
    },
    digitalocean: {
      apiToken: parsedEnv['DIGITALOCEAN_API_TOKEN'] ?? null,
      domain: parsedEnv['DIGITALOCEAN_DOMAIN'] ?? null,
    },
  };

  const parsedConfig = appConfigSchema.parse(config);
  validateProviderConfig(parsedConfig);
  return parsedConfig;
}

function parseUrlList(value: string | undefined): string[] | null {
  if (value == null || value.trim() === '') {
    return null;
  }
  const urls = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const url of urls) {
    if (!isHttpsUrl(url)) {
      throw new Error(`IP discovery endpoint must be https:// URL: ${url}`);
    }
  }
  return urls;
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
    case 'route53':
      if (!config.route53.accessKeyId) missing.push('ROUTE53_ACCESS_KEY_ID');
      if (!config.route53.secretAccessKey) missing.push('ROUTE53_SECRET_ACCESS_KEY');
      if (!config.route53.hostedZoneId) missing.push('ROUTE53_HOSTED_ZONE_ID');
      break;
    case 'porkbun':
      if (!config.porkbun.apiKey) missing.push('PORKBUN_API_KEY');
      if (!config.porkbun.secretKey) missing.push('PORKBUN_SECRET_KEY');
      if (!config.porkbun.domain && config.hosts.some((host) => !host.includes('.'))) {
        missing.push('PORKBUN_DOMAIN (required when hosts are not FQDNs)');
      }
      break;
    case 'hetzner':
      if (!config.hetzner.apiToken) missing.push('HETZNER_API_TOKEN');
      break;
    case 'digitalocean':
      if (!config.digitalocean.apiToken) missing.push('DIGITALOCEAN_API_TOKEN');
      if (!config.digitalocean.domain && config.hosts.some((host) => !host.includes('.'))) {
        missing.push('DIGITALOCEAN_DOMAIN (required when hosts are not FQDNs)');
      }
      break;
  }

  if (missing.length > 0) {
    throw new Error(`Invalid ${config.provider} configuration; missing: ${missing.join(', ')}`);
  }
}

export type { AppConfig };
