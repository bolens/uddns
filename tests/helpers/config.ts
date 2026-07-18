import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DNS_TTL,
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
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from '../../lib/defaults.js';
import type { AccountRole, LoadedAccount } from '../../lib/config-file.js';
import type {
  AppConfig,
  CloudflareConfig,
  DigitalOceanConfig,
  BunnyConfig,
  ContaboConfig,
  DuckDnsConfig,
  DynDnsConfig,
  HetznerConfig,
  GandiConfig,
  LinodeConfig,
  NamecheapConfig,
  PorkbunConfig,
  OvhConfig,
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
    | 'gandi'
    | 'linode'
    | 'ovh'
    | 'bunny'
    | 'contabo'
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
  gandi?: Partial<GandiConfig>;
  linode?: Partial<LinodeConfig>;
  ovh?: Partial<OvhConfig>;
  bunny?: Partial<BunnyConfig>;
  contabo?: Partial<ContaboConfig>;
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
    gandi: gandiOverrides,
    linode: linodeOverrides,
    ovh: ovhOverrides,
    bunny: bunnyOverrides,
    contabo: contaboOverrides,
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
    retryAttempts: DEFAULT_RETRY_ATTEMPTS,
    retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    telemetryEnabled: false,
    notifyWebhookUrl: null,
    notifyNtfyUrl: null,
    notifySlackUrl: null,
    notifyDiscordUrl: null,
    notifyOn: [...DEFAULT_NOTIFY_ON],
    disabledHosts: [],
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
    gandi: {
      apiToken: null,
      domain: null,
      ttl: DEFAULT_DNS_TTL,
      ...gandiOverrides,
    },
    linode: {
      apiToken: null,
      domainId: null,
      domain: null,
      ttl: DEFAULT_DNS_TTL,
      ...linodeOverrides,
    },
    ovh: {
      endpoint: 'eu',
      applicationKey: null,
      applicationSecret: null,
      consumerKey: null,
      zone: null,
      ttl: DEFAULT_DNS_TTL,
      ...ovhOverrides,
    },
    bunny: {
      apiKey: null,
      zoneId: null,
      domain: null,
      ttl: DEFAULT_DNS_TTL,
      ...bunnyOverrides,
    },
    contabo: {
      clientId: null,
      clientSecret: null,
      apiUser: null,
      apiPassword: null,
      zone: null,
      ttl: DEFAULT_DNS_TTL,
      ...contaboOverrides,
    },
  };
}

/** Build a LoadedAccount for multi-account / failover tests. */
export function makeLoadedAccount(
  id: string,
  overrides: MakeConfigOverrides & {
    role?: AccountRole;
    failoverAccountIds?: string[];
  } = {},
): LoadedAccount {
  const { role = 'primary', failoverAccountIds = [], ...configOverrides } = overrides;
  return {
    id,
    config: makeConfig(configOverrides),
    role,
    failoverAccountIds,
  };
}
