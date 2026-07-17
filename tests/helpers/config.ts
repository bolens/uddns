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
    provider: 'cloudflare',
    interval: 900_000,
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
      ttl: 1,
      createIfMissing: true,
      ...cloudflareOverrides,
    },
    duckdns: {
      domains: null,
      token: null,
      ...duckdnsOverrides,
    },
    namecheap: {
      host: '@',
      domain: null,
      password: null,
      ...namecheapOverrides,
    },
    dyndns: {
      updateUrl: 'https://members.dyndns.org/nic/update',
      username: null,
      password: null,
      hostname,
      ...dyndnsOverrides,
    },
  };
}
