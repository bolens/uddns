import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { ContaboConfig, Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost } from './domain-host.js';
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
    const host = splitDomainHost(config.hostname, auth.zone);
    if (!host) return fail(`Host ${config.hostname} is outside CONTABO_ZONE`);
    const token = await getToken(auth);
    if (!token) return fail('Contabo OAuth authentication failed');
    const results: UpdateResult[] = [];
    if (ip.v4) results.push(await upsert(token, auth, host.name, 'A', ip.v4));
    if (ip.v6) results.push(await upsert(token, auth, host.name, 'AAAA', ip.v6));
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
  const parsed = result.response.ok ? tokenSchema.safeParse(JSON.parse(result.body)) : null;
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
  const listed = await request(base, { headers });
  const parsed = listed.response.ok ? recordsSchema.safeParse(JSON.parse(listed.body)) : null;
  if (!parsed?.success) return fail('Contabo record lookup failed', { http: listed.meta });
  const label = name === '@' ? '' : name;
  const record = parsed.data.data.find(
    (item) => item.type === type && (item.name === label || item.name === `${label}.${auth.zone}`),
  );
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
