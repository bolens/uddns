import { z } from 'zod';

import type { JsonObject } from './json.js';

export const PROVIDER_IDS = [
  'cloudflare',
  'duckdns',
  'noip',
  'dynu',
  'namecheap',
  'dyndns',
] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

const publicIpSchema = z.object({
  v4: z.string().nullable(),
  v6: z.string().nullable(),
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
  ttl: z.number(),
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

export const appConfigSchema = z.object({
  provider: providerIdSchema,
  interval: z.number(),
  hosts: z.array(z.string()).min(1),
  hostname: z.string().nullable(),
  user: z.string().nullable(),
  password: z.string().nullable(),
  token: z.string().nullable(),
  cloudflare: cloudflareConfigSchema,
  duckdns: duckDnsConfigSchema,
  namecheap: namecheapConfigSchema,
  dyndns: dynDnsConfigSchema,
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

export type CheckResult = {
  status: 'updated' | 'unchanged' | 'skipped_no_ip' | 'error' | 'partial';
  ip: PublicIP;
  message: string;
  hostResults?: HostUpdateResult[];
};
