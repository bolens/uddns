import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { ContaboConfig, Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost, normalizeDnsName } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request } from './http.js';

const tokenSchema = z.object({ access_token: z.string() });
const recordsSchema = z.object({
  data: z.array(
    z.object({
      recordId: z.number(),
      name: z.string(),
      type: z.string(),
      ttl: z.number(),
      data: z.string(),
    }),
  ),
});

export const contaboProvider: Provider = {
  id: 'contabo',
  label: 'Contabo DNS',
  async update(config, ip) {
    const auth = config.contabo;
    const missing = requireFields('contabo requires OAuth credentials and CONTABO_ZONE', [
      auth.clientId,
      auth.clientSecret,
      auth.apiUser,
      auth.apiPassword,
      auth.zone,
    ]);
    if (missing) return missing;
    if (!config.hostname) return fail('contabo requires UDDNS_HOST or UDDNS_HOSTS');
    const zone = normalizeDnsName(auth.zone!);
    const host = splitDomainHost(config.hostname, zone);
    if (!host) return fail(`Host ${config.hostname} is outside CONTABO_ZONE`);
    const token = await getToken(auth);
    if (!token) return fail('Contabo OAuth authentication failed');
    const scoped = { ...auth, zone };
    const results: UpdateResult[] = [];
    if (ip.v4) results.push(await upsert(token, scoped, host.name, 'A', ip.v4));
    if (ip.v6) results.push(await upsert(token, scoped, host.name, 'AAAA', ip.v6));
    return results.length ? combineRecordResults(results, host) : fail('No public IP available');
  },
};

async function getToken(auth: ContaboConfig): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: auth.clientId!,
    client_secret: auth.clientSecret!,
    username: auth.apiUser!,
    password: auth.apiPassword!,
  });
  const result = await request(
    'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  const parsed = result.response.ok
    ? (() => {
        try {
          return tokenSchema.safeParse(JSON.parse(result.body));
        } catch {
          return null;
        }
      })()
    : null;
  return parsed?.success ? parsed.data.access_token : null;
}

async function upsert(
  token: string,
  auth: ContaboConfig,
  name: string,
  type: 'A' | 'AAAA',
  data: string,
): Promise<UpdateResult> {
  const zone = encodeURIComponent(auth.zone!);
  const base = `https://api.contabo.com/v1/dns/zones/${zone}/records`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-request-id': randomUUID(),
  };
  const label = name === '@' ? '' : name;
  const fqdn = label ? `${label}.${auth.zone}` : auth.zone!;
  const listed = await request(`${base}?search=${encodeURIComponent(fqdn)}&size=100`, {
    headers,
  });
  let parsed: ReturnType<typeof recordsSchema.safeParse> | null = null;
  if (listed.response.ok) {
    try {
      parsed = recordsSchema.safeParse(JSON.parse(listed.body));
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.success) return fail('Contabo record lookup failed', { http: listed.meta });
  const matches = parsed.data.data.filter(
    (item) => item.type === type && contaboNameMatches(item.name, name, auth.zone!),
  );
  if (matches.length > 1) {
    return fail(
      `Multiple ${type} records for ${name === '@' ? auth.zone : name}; remove duplicates before updating`,
      { zone: auth.zone, type, name, count: matches.length },
    );
  }
  const record = matches[0] ?? null;
  if (record?.data === data && record.ttl === auth.ttl) {
    return skipped(`${type} ${name} unchanged (${data})`);
  }
  const changed = await request(record ? `${base}/${record.recordId}` : base, {
    method: record ? 'PATCH' : 'POST',
    headers: { ...headers, 'x-request-id': randomUUID() },
    body: JSON.stringify({
      ...(record ? {} : { name: label }),
      type,
      ttl: auth.ttl,
      prio: 0,
      data,
    }),
  });
  return changed.response.ok
    ? ok(`${type} ${name} -> ${data}`, { http: changed.meta })
    : fail(`Contabo record update failed (HTTP ${changed.meta.status})`, {
        http: changed.meta,
      });
}

/** Match Contabo record names without letting apex aliases steal subdomain updates. */
function contaboNameMatches(itemName: string, recordName: string, zone: string): boolean {
  const item = normalizeDnsName(itemName);
  const apex = normalizeDnsName(zone);
  if (recordName === '@') {
    return item === '@' || item === '' || item === apex;
  }
  const label = normalizeDnsName(recordName);
  return item === label || item === `${label}.${apex}`;
}
