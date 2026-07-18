import { z } from 'zod';

import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DNS_TTL,
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
import { parseHostList, resolveHosts } from '../hosts.js';
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
    UDDNS_DISABLED_HOSTS: optionalEnv,
    UDDNS_USER: optionalEnv,
    UDDNS_PASS: optionalEnv,
    UDDNS_TOKEN: optionalEnv,
    UDDNS_IP_FAMILY: optionalEnv,
    UDDNS_IP_MISSING: optionalEnv,
    UDDNS_IP_HTTPS_V4: optionalEnv,
    UDDNS_IP_HTTPS_V6: optionalEnv,
    UDDNS_IP_DNS_FALLBACK: optionalEnv,
    UDDNS_IP_TIMEOUT_MS: optionalEnv,
    UDDNS_OTEL: optionalEnv,
    UDDNS_NOTIFY_WEBHOOK_URL: optionalEnv,
    UDDNS_NOTIFY_NTFY_URL: optionalEnv,
    UDDNS_NOTIFY_SLACK_URL: optionalEnv,
    UDDNS_NOTIFY_DISCORD_URL: optionalEnv,
    UDDNS_NOTIFY_ON: optionalEnv,
    UDDNS_HEALTH: optionalEnv,
    UDDNS_HEALTH_HOST: optionalEnv,
    UDDNS_HEALTH_PORT: optionalEnv,
    UDDNS_HEALTH_AUTH_TOKEN: optionalEnv,
    UDDNS_HEALTH_TLS_CERT: optionalEnv,
    UDDNS_HEALTH_TLS_KEY: optionalEnv,
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
    GANDI_API_TOKEN: optionalEnv,
    GANDI_DOMAIN: optionalEnv,
    GANDI_TTL: optionalEnv,
    LINODE_API_TOKEN: optionalEnv,
    LINODE_DOMAIN_ID: optionalEnv,
    LINODE_DOMAIN: optionalEnv,
    LINODE_TTL: optionalEnv,
    OVH_ENDPOINT: optionalEnv,
    OVH_APPLICATION_KEY: optionalEnv,
    OVH_APPLICATION_SECRET: optionalEnv,
    OVH_CONSUMER_KEY: optionalEnv,
    OVH_ZONE: optionalEnv,
    OVH_TTL: optionalEnv,
    BUNNY_API_KEY: optionalEnv,
    BUNNY_ZONE_ID: optionalEnv,
    BUNNY_DOMAIN: optionalEnv,
    BUNNY_TTL: optionalEnv,
    CONTABO_CLIENT_ID: optionalEnv,
    CONTABO_CLIENT_SECRET: optionalEnv,
    CONTABO_API_USER: optionalEnv,
    CONTABO_API_PASSWORD: optionalEnv,
    CONTABO_ZONE: optionalEnv,
    CONTABO_TTL: optionalEnv,
  })
  .passthrough();

export const MANAGED_ENV_PREFIXES = [
  'UDDNS_',
  'CLOUDFLARE_',
  'DUCKDNS_',
  'NAMECHEAP_',
  'DYNDNS_',
  'ROUTE53_',
  'PORKBUN_',
  'HETZNER_',
  'DIGITALOCEAN_',
  'GANDI_',
  'LINODE_',
  'OVH_',
  'BUNNY_',
  'CONTABO_',
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
  const disabledHosts = parseHostList(parsedEnv['UDDNS_DISABLED_HOSTS']);
  const unknownDisabledHosts = disabledHosts.filter((host) => !hosts.includes(host));
  if (unknownDisabledHosts.length > 0) {
    throw new Error(
      `UDDNS_DISABLED_HOSTS contains unknown configured host(s): ${unknownDisabledHosts.join(', ')}`,
    );
  }
  if (disabledHosts.length === hosts.length) {
    throw new Error('UDDNS_DISABLED_HOSTS cannot disable every configured host');
  }

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
  const slackUrl = parsedEnv['UDDNS_NOTIFY_SLACK_URL']?.trim() || null;
  if (slackUrl && !isHttpsUrl(slackUrl)) {
    throw new Error('UDDNS_NOTIFY_SLACK_URL must be a valid https:// URL');
  }
  const discordUrl = parsedEnv['UDDNS_NOTIFY_DISCORD_URL']?.trim() || null;
  if (discordUrl && !isHttpsUrl(discordUrl)) {
    throw new Error('UDDNS_NOTIFY_DISCORD_URL must be a valid https:// URL');
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
    disabledHosts,
    hostname: firstHost,
    user: parsedEnv['UDDNS_USER'] ?? null,
    password: parsedEnv['UDDNS_PASS'] ?? null,
    token: parsedEnv['UDDNS_TOKEN'] ?? null,
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
    telemetryEnabled: parseBoolean('UDDNS_OTEL', parsedEnv['UDDNS_OTEL'], false),
    notifyWebhookUrl: webhookUrl,
    notifyNtfyUrl: ntfyUrl,
    notifySlackUrl: slackUrl,
    notifyDiscordUrl: discordUrl,
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
      password:
        parsedEnv['UDDNS_PASS'] ??
        (providerResult.data === 'dynu' ? (parsedEnv['UDDNS_TOKEN'] ?? null) : null),
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
    gandi: {
      apiToken: parsedEnv['GANDI_API_TOKEN'] ?? null,
      domain: parsedEnv['GANDI_DOMAIN'] ?? null,
      ttl: Number(parsedEnv['GANDI_TTL'] ?? DEFAULT_DNS_TTL),
    },
    linode: {
      apiToken: parsedEnv['LINODE_API_TOKEN'] ?? null,
      domainId: parsedEnv['LINODE_DOMAIN_ID'] ? Number(parsedEnv['LINODE_DOMAIN_ID']) : null,
      domain: parsedEnv['LINODE_DOMAIN'] ?? null,
      ttl: Number(parsedEnv['LINODE_TTL'] ?? DEFAULT_DNS_TTL),
    },
    ovh: {
      endpoint: (() => {
        const raw = (parsedEnv['OVH_ENDPOINT'] ?? 'eu').toLowerCase();
        if (raw === 'eu' || raw === 'ca' || raw === 'us') {
          return raw;
        }
        throw new Error('OVH_ENDPOINT must be one of: eu, ca, us');
      })(),
      applicationKey: parsedEnv['OVH_APPLICATION_KEY'] ?? null,
      applicationSecret: parsedEnv['OVH_APPLICATION_SECRET'] ?? null,
      consumerKey: parsedEnv['OVH_CONSUMER_KEY'] ?? null,
      zone: parsedEnv['OVH_ZONE'] ?? null,
      ttl: Number(parsedEnv['OVH_TTL'] ?? DEFAULT_DNS_TTL),
    },
    bunny: {
      apiKey: parsedEnv['BUNNY_API_KEY'] ?? null,
      zoneId: parsedEnv['BUNNY_ZONE_ID'] ? Number(parsedEnv['BUNNY_ZONE_ID']) : null,
      domain: parsedEnv['BUNNY_DOMAIN'] ?? null,
      ttl: Number(parsedEnv['BUNNY_TTL'] ?? DEFAULT_DNS_TTL),
    },
    contabo: {
      clientId: parsedEnv['CONTABO_CLIENT_ID'] ?? null,
      clientSecret: parsedEnv['CONTABO_CLIENT_SECRET'] ?? null,
      apiUser: parsedEnv['CONTABO_API_USER'] ?? null,
      apiPassword: parsedEnv['CONTABO_API_PASSWORD'] ?? null,
      zone: parsedEnv['CONTABO_ZONE'] ?? null,
      ttl: Number(parsedEnv['CONTABO_TTL'] ?? DEFAULT_DNS_TTL),
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

export type ConfigIssue = {
  field: string;
  message: string;
  suggestion: string;
};

export function getProviderConfigIssues(config: AppConfig): ConfigIssue[] {
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
      if (
        !config.namecheap.domain &&
        config.hosts.some((host) => {
          const labels = host.split('.').filter(Boolean).length;
          return labels < 2 || labels > 3;
        })
      ) {
        missing.push(
          'NAMECHEAP_DOMAIN (required for bare labels and multi-label domains like example.co.uk)',
        );
      }
      break;
    case 'noip':
    case 'dyndns':
      if (!config.dyndns.username) missing.push('UDDNS_USER');
      if (!config.dyndns.password) missing.push('UDDNS_PASS');
      if (!config.dyndns.hostname) missing.push('UDDNS_HOST(S)');
      break;
    case 'dynu':
      if (!config.dyndns.username) missing.push('UDDNS_USER');
      if (!config.dyndns.password && !config.password && !config.token) {
        missing.push('UDDNS_PASS or UDDNS_TOKEN');
      }
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
      if (
        !config.porkbun.domain &&
        config.hosts.some((host) => {
          const labels = host.split('.').filter(Boolean).length;
          return labels < 2 || labels > 3;
        })
      ) {
        missing.push(
          'PORKBUN_DOMAIN (required for bare labels and multi-label domains like example.co.uk)',
        );
      }
      break;
    case 'hetzner':
      if (!config.hetzner.apiToken) missing.push('HETZNER_API_TOKEN');
      break;
    case 'digitalocean':
      if (!config.digitalocean.apiToken) missing.push('DIGITALOCEAN_API_TOKEN');
      if (
        !config.digitalocean.domain &&
        config.hosts.some((host) => {
          const labels = host.split('.').filter(Boolean).length;
          return labels < 2 || labels > 3;
        })
      ) {
        missing.push(
          'DIGITALOCEAN_DOMAIN (required for bare labels and multi-label domains like example.co.uk)',
        );
      }
      break;
    case 'gandi':
      if (!config.gandi.apiToken) missing.push('GANDI_API_TOKEN');
      if (!config.gandi.domain) missing.push('GANDI_DOMAIN');
      break;
    case 'linode':
      if (!config.linode.apiToken) missing.push('LINODE_API_TOKEN');
      if (!config.linode.domainId) missing.push('LINODE_DOMAIN_ID');
      if (!config.linode.domain) missing.push('LINODE_DOMAIN');
      break;
    case 'ovh':
      if (!config.ovh.applicationKey) missing.push('OVH_APPLICATION_KEY');
      if (!config.ovh.applicationSecret) missing.push('OVH_APPLICATION_SECRET');
      if (!config.ovh.consumerKey) missing.push('OVH_CONSUMER_KEY');
      if (!config.ovh.zone) missing.push('OVH_ZONE');
      break;
    case 'bunny':
      if (!config.bunny.apiKey) missing.push('BUNNY_API_KEY');
      if (!config.bunny.zoneId) missing.push('BUNNY_ZONE_ID');
      if (!config.bunny.domain) missing.push('BUNNY_DOMAIN');
      break;
    case 'contabo':
      if (!config.contabo.clientId) missing.push('CONTABO_CLIENT_ID');
      if (!config.contabo.clientSecret) missing.push('CONTABO_CLIENT_SECRET');
      if (!config.contabo.apiUser) missing.push('CONTABO_API_USER');
      if (!config.contabo.apiPassword) missing.push('CONTABO_API_PASSWORD');
      if (!config.contabo.zone) missing.push('CONTABO_ZONE');
      break;
  }

  return missing.map((field) => ({
    field,
    message: `Missing required configuration: ${field}`,
    suggestion: `Set ${field} for the ${config.provider} provider`,
  }));
}

export function validateProviderConfig(config: AppConfig): void {
  const issues = getProviderConfigIssues(config);
  if (issues.length > 0) {
    throw new Error(
      `Invalid ${config.provider} configuration; missing: ${issues
        .map((issue) => issue.field)
        .join(', ')}`,
    );
  }
}

export type { AppConfig };
