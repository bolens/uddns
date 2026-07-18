import { z } from 'zod';
import { isIPv4, isIPv6 } from 'node:net';

import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from '../defaults.js';
import type { JsonObject } from './json.js';

export const PROVIDER_IDS = [
  'cloudflare',
  'duckdns',
  'noip',
  'dynu',
  'namecheap',
  'dyndns',
  'route53',
  'porkbun',
  'hetzner',
  'digitalocean',
  'gandi',
  'linode',
  'ovh',
  'bunny',
  'contabo',
] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const publicIpSchema = z.object({
  v4: z
    .string()
    .refine((value) => isIPv4(value), 'Invalid IPv4 address')
    .nullable(),
  v6: z
    .string()
    .refine((value) => isIPv6(value), 'Invalid IPv6 address')
    .nullable(),
});
export type PublicIP = z.infer<typeof publicIpSchema>;

type UpdateResultBase = {
  message: string;
  details?: JsonObject;
};

export type UpdateResult =
  | (UpdateResultBase & {
      ok: true;
      skipped?: boolean;
    })
  | (UpdateResultBase & {
      ok: false;
      skipped?: never;
    });

const cloudflareConfigSchema = z.object({
  apiToken: z.string().nullable(),
  zoneId: z.string().nullable(),
  zoneName: z.string().nullable(),
  recordName: z.string().nullable(),
  recordId: z.string().nullable(),
  proxied: z.boolean(),
  ttl: z
    .number()
    .int()
    .refine((value) => value === 1 || (value >= 60 && value <= 86_400), {
      message: 'Cloudflare TTL must be 1 (automatic) or an integer from 60 to 86400',
    }),
  createIfMissing: z.boolean(),
});
export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

const duckDnsConfigSchema = z.object({
  domains: z.string().nullable(),
  token: z.string().nullable(),
});
export type DuckDnsConfig = z.infer<typeof duckDnsConfigSchema>;

const namecheapConfigSchema = z.object({
  host: z.string(),
  domain: z.string().nullable(),
  password: z.string().nullable(),
});
export type NamecheapConfig = z.infer<typeof namecheapConfigSchema>;

const dynDnsConfigSchema = z.object({
  updateUrl: z.string(),
  username: z.string().nullable(),
  password: z.string().nullable(),
  hostname: z.string().nullable(),
});
export type DynDnsConfig = z.infer<typeof dynDnsConfigSchema>;

const route53ConfigSchema = z.object({
  accessKeyId: z.string().nullable(),
  secretAccessKey: z.string().nullable(),
  region: z.string().min(1),
  hostedZoneId: z.string().nullable(),
  ttl: z
    .number()
    .int()
    .refine((value) => value >= 0 && value <= 2_147_483_647, {
      message: 'Route53 TTL must be an integer from 0 to 2147483647',
    }),
  createIfMissing: z.boolean(),
});
export type Route53Config = z.infer<typeof route53ConfigSchema>;

const porkbunConfigSchema = z.object({
  apiKey: z.string().nullable(),
  secretKey: z.string().nullable(),
  domain: z.string().nullable(),
});
export type PorkbunConfig = z.infer<typeof porkbunConfigSchema>;

const hetznerConfigSchema = z.object({
  apiToken: z.string().nullable(),
  zoneId: z.string().nullable(),
  zoneName: z.string().nullable(),
});
export type HetznerConfig = z.infer<typeof hetznerConfigSchema>;

const digitalOceanConfigSchema = z.object({
  apiToken: z.string().nullable(),
  domain: z.string().nullable(),
});
export type DigitalOceanConfig = z.infer<typeof digitalOceanConfigSchema>;

const simpleDomainConfigSchema = z.object({
  apiToken: z.string().nullable(),
  domain: z.string().nullable(),
  ttl: z.number().int().min(0),
});
export type GandiConfig = z.infer<typeof simpleDomainConfigSchema>;

const linodeConfigSchema = simpleDomainConfigSchema.extend({
  domainId: z.number().int().positive().nullable(),
});
export type LinodeConfig = z.infer<typeof linodeConfigSchema>;

const ovhConfigSchema = z.object({
  endpoint: z.enum(['eu', 'ca', 'us']),
  applicationKey: z.string().nullable(),
  applicationSecret: z.string().nullable(),
  consumerKey: z.string().nullable(),
  zone: z.string().nullable(),
  ttl: z.number().int().min(0),
});
export type OvhConfig = z.infer<typeof ovhConfigSchema>;

const bunnyConfigSchema = z.object({
  apiKey: z.string().nullable(),
  zoneId: z.number().int().positive().nullable(),
  domain: z.string().nullable(),
  ttl: z.number().int().min(0),
});
export type BunnyConfig = z.infer<typeof bunnyConfigSchema>;

const contaboConfigSchema = z.object({
  clientId: z.string().nullable(),
  clientSecret: z.string().nullable(),
  apiUser: z.string().nullable(),
  apiPassword: z.string().nullable(),
  zone: z.string().nullable(),
  ttl: z.number().int().min(0),
});
export type ContaboConfig = z.infer<typeof contaboConfigSchema>;

const notifyOnSchema = z.enum(['change', 'error']);

export const appConfigSchema = z.object({
  provider: providerIdSchema,
  interval: z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS),
  stateFile: z.string().min(1).nullable(),
  historyFile: z.string().min(1).nullable(),
  hosts: z.array(z.string()).min(1),
  disabledHosts: z.array(z.string()),
  hostname: z.string().nullable(),
  user: z.string().nullable(),
  password: z.string().nullable(),
  token: z.string().nullable(),
  ipFamily: z.enum(['dual', 'v4', 'v6']),
  ipMissing: z.enum(['keep', 'clear']),
  ipHttpsV4: z.array(z.string().url()).nullable(),
  ipHttpsV6: z.array(z.string().url()).nullable(),
  ipDnsFallback: z.boolean(),
  ipTimeoutMs: z.number().int().min(100).max(120_000),
  telemetryEnabled: z.boolean(),
  notifyWebhookUrl: z.string().nullable(),
  notifyNtfyUrl: z.string().nullable(),
  notifySlackUrl: z.string().nullable(),
  notifyDiscordUrl: z.string().nullable(),
  notifyOn: z.array(notifyOnSchema).min(1),
  cloudflare: cloudflareConfigSchema,
  duckdns: duckDnsConfigSchema,
  namecheap: namecheapConfigSchema,
  dyndns: dynDnsConfigSchema,
  route53: route53ConfigSchema,
  porkbun: porkbunConfigSchema,
  hetzner: hetznerConfigSchema,
  digitalocean: digitalOceanConfigSchema,
  gandi: simpleDomainConfigSchema,
  linode: linodeConfigSchema,
  ovh: ovhConfigSchema,
  bunny: bunnyConfigSchema,
  contabo: contaboConfigSchema,
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export type Provider = {
  id: ProviderId;
  label: string;
  update: (config: AppConfig, ip: PublicIP) => Promise<UpdateResult>;
};

export type HostUpdateResult = {
  host: string;
  result: UpdateResult;
  durationMs?: number;
};

export type CheckResultStatus =
  | 'updated'
  | 'unchanged'
  | 'skipped_no_ip'
  | 'error'
  | 'partial'
  | 'dry_run';

export type CheckResult = {
  status: CheckResultStatus;
  ip: PublicIP;
  message: string;
  hostResults?: HostUpdateResult[];
  forced?: boolean;
  dryRun?: boolean;
};
