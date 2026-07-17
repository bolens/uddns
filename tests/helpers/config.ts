import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DYNDNS_UPDATE_URL,
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
} from '../../lib/defaults.js';
import type {
  AppConfig,
  CloudflareConfig,
  DigitalOceanConfig,
  DuckDnsConfig,
  DynDnsConfig,
  HetznerConfig,
  NamecheapConfig,
  PorkbunConfig,
  Route53Config,
} from '../../lib/schemas/provider.js';

export type MakeConfigOverrides = Partial<
  Omit<
    AppConfig,
    | 'cloudflare'
    | 'duckdns'
    | 'namecheap'
    | 'dyndns'
    | 'route53'
    | 'porkbun'
    | 'hetzner'
    | 'digitalocean'
  >
> & {
  cloudflare?: Partial<CloudflareConfig>;
  duckdns?: Partial<DuckDnsConfig>;
  namecheap?: Partial<NamecheapConfig>;
  dyndns?: Partial<DynDnsConfig>;
  route53?: Partial<Route53Config>;
  porkbun?: Partial<PorkbunConfig>;
  hetzner?: Partial<HetznerConfig>;
  digitalocean?: Partial<DigitalOceanConfig>;
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
    route53: route53Overrides,
    porkbun: porkbunOverrides,
    hetzner: hetznerOverrides,
    digitalocean: digitaloceanOverrides,
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
    historyFile: null,
    user: null,
    password: null,
    token: null,
    ipFamily: DEFAULT_IP_FAMILY,
    ipMissing: DEFAULT_IP_MISSING,
    ipHttpsV4: null,
    ipHttpsV6: null,
    ipDnsFallback: DEFAULT_IP_DNS_FALLBACK,
    ipTimeoutMs: DEFAULT_IP_TIMEOUT_MS,
    notifyWebhookUrl: null,
    notifyNtfyUrl: null,
    notifyOn: [...DEFAULT_NOTIFY_ON],
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
    route53: {
      accessKeyId: null,
      secretAccessKey: null,
      region: DEFAULT_ROUTE53_REGION,
      hostedZoneId: null,
      ttl: DEFAULT_ROUTE53_TTL,
      createIfMissing: true,
      ...route53Overrides,
    },
    porkbun: {
      apiKey: null,
      secretKey: null,
      domain: null,
      ...porkbunOverrides,
    },
    hetzner: {
      apiToken: null,
      zoneId: null,
      zoneName: null,
      ...hetznerOverrides,
    },
    digitalocean: {
      apiToken: null,
      domain: null,
      ...digitaloceanOverrides,
    },
  };
}
