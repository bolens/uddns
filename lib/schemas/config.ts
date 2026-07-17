import { z } from 'zod';

import { resolveHosts } from '../hosts.js';
import { appConfigSchema, PROVIDER_IDS, providerIdSchema, type AppConfig } from './provider.js';

const optionalEnv = z.string().optional();
const envSchema = z
  .object({
    UDDNS_PROVIDER: optionalEnv,
    UDDNS_INTERVAL: optionalEnv,
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Load and validate runtime configuration from environment variables.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AppConfig {
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

  const firstHost = hosts[0] ?? null;

  const config = {
    provider: providerResult.data,
    interval,
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
      proxied: parseBoolean(parsedEnv['CLOUDFLARE_PROXIED'], false),
      ttl: Number(parsedEnv['CLOUDFLARE_TTL'] ?? 1),
      createIfMissing: parseBoolean(parsedEnv['CLOUDFLARE_CREATE_IF_MISSING'], true),
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
      updateUrl: parsedEnv['DYNDNS_UPDATE_URL'] ?? 'https://members.dyndns.org/nic/update',
      username: parsedEnv['UDDNS_USER'] ?? null,
      password: parsedEnv['UDDNS_PASS'] ?? null,
      hostname: firstHost,
    },
  };

  return appConfigSchema.parse(config);
}

export type { AppConfig };
