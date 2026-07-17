import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DYNDNS_UPDATE_URL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_NAMECHEAP_HOST,
  DEFAULT_PROVIDER,
} from '../../lib/defaults.js';
import type {
  AppConfig,
  CloudflareConfig,
  DuckDnsConfig,
  DynDnsConfig,
  NamecheapConfig,
} from '../../lib/schemas/provider.js';

export type MakeConfigOverrides = Partial<
  Omit<AppConfig, 'cloudflare' | 'duckdns' | 'namecheap' | 'dyndns'>
> & {
  cloudflare?: Partial<CloudflareConfig>;
  duckdns?: Partial<DuckDnsConfig>;
  namecheap?: Partial<NamecheapConfig>;
  dyndns?: Partial<DynDnsConfig>;
};

/**
 * Build a minimal AppConfig for provider unit tests.
 */
export function makeConfig(overrides: MakeConfigOverrides = {}): AppConfig {
  const {
    cloudflare: cloudflareOverrides,
    duckdns: duckdnsOverrides,
    namecheap: namecheapOverrides,
    dyndns: dyndnsOverrides,
    hosts: hostsOverride,
    hostname: hostnameOverride,
    ...rest
  } = overrides;

  const hosts = hostsOverride ?? (hostnameOverride ? [hostnameOverride] : ['home.example.com']);
  const hostname = hostnameOverride ?? hosts[0] ?? null;

  return {
    provider: DEFAULT_PROVIDER,
    interval: DEFAULT_INTERVAL_MS,
    stateFile: null,
    user: null,
    password: null,
    token: null,
    ...rest,
    hosts,
    hostname,
    cloudflare: {
      apiToken: null,
      zoneId: null,
      zoneName: null,
      recordName: hostname,
      recordId: null,
      proxied: false,
      ttl: DEFAULT_CLOUDFLARE_TTL,
      createIfMissing: true,
      ...cloudflareOverrides,
    },
    duckdns: {
      domains: null,
      token: null,
      ...duckdnsOverrides,
    },
    namecheap: {
      host: DEFAULT_NAMECHEAP_HOST,
      domain: null,
      password: null,
      ...namecheapOverrides,
    },
    dyndns: {
      updateUrl: DEFAULT_DYNDNS_UPDATE_URL,
      username: null,
      password: null,
      hostname,
      ...dyndnsOverrides,
    },
  };
}
