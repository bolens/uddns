import { createHash } from 'node:crypto';
import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { OvhConfig, Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request } from './http.js';

const idsSchema = z.array(z.number());
const recordSchema = z.object({ id: z.number(), target: z.string(), ttl: z.number() });
const BASE = {
  eu: 'https://eu.api.ovh.com/1.0',
  ca: 'https://ca.api.ovh.com/1.0',
  us: 'https://api.us.ovhcloud.com/1.0',
} as const;

export const ovhProvider: Provider = {
  id: 'ovh',
  label: 'OVHcloud',
  async update(config, ip) {
    const auth = config.ovh;
    const missing = requireFields('ovh requires application, consumer, and zone credentials', [
      auth.applicationKey,
      auth.applicationSecret,
      auth.consumerKey,
      auth.zone,
    ]);
    if (missing) return missing;
    if (!config.hostname) return fail('ovh requires UDDNS_HOST or UDDNS_HOSTS');
    const host = splitDomainHost(config.hostname, auth.zone);
    if (!host) return fail(`Host ${config.hostname} is outside OVH_ZONE`);
    const results: UpdateResult[] = [];
    if (ip.v4) results.push(await upsert(auth, host.name, 'A', ip.v4));
    if (ip.v6) results.push(await upsert(auth, host.name, 'AAAA', ip.v6));
    if (results.some((result) => result.ok && !result.skipped)) {
      await signedRequest(auth, 'POST', `/domain/zone/${encodeURIComponent(auth.zone!)}/refresh`);
    }
    return results.length ? combineRecordResults(results, host) : fail('No public IP available');
  },
};

async function upsert(
  auth: OvhConfig,
  name: string,
  type: 'A' | 'AAAA',
  target: string,
): Promise<UpdateResult> {
  const zone = encodeURIComponent(auth.zone!);
  const subDomain = name === '@' ? '' : name;
  const listPath = `/domain/zone/${zone}/record?fieldType=${type}&subDomain=${encodeURIComponent(subDomain)}`;
  const listed = await signedRequest(auth, 'GET', listPath);
  if (!listed.response.ok)
    return fail(`OVH record lookup failed (HTTP ${listed.meta.status})`, { http: listed.meta });
  const ids = idsSchema.safeParse(JSON.parse(listed.body));
  if (!ids.success) return fail('OVH returned invalid record IDs');
  let record: z.infer<typeof recordSchema> | null = null;
  if (ids.data[0] !== undefined) {
    const current = await signedRequest(auth, 'GET', `/domain/zone/${zone}/record/${ids.data[0]}`);
    if (!current.response.ok) {
      return fail('OVH returned invalid record data', { http: current.meta });
    }
    const parsed = recordSchema.safeParse(JSON.parse(current.body));
    if (!parsed.success) return fail('OVH returned invalid record data', { http: current.meta });
    record = parsed.data;
  }
  if (record?.target === target && record.ttl === auth.ttl) {
    return skipped(`${type} ${name} unchanged (${target})`);
  }
  const path = record ? `/domain/zone/${zone}/record/${record.id}` : `/domain/zone/${zone}/record`;
  const changed = await signedRequest(auth, record ? 'PUT' : 'POST', path, {
    ...(record ? {} : { fieldType: type }),
    subDomain,
    target,
    ttl: auth.ttl,
  });
  return changed.response.ok
    ? ok(`${type} ${name} -> ${target}`, { http: changed.meta })
    : fail(`OVH record update failed (HTTP ${changed.meta.status})`, { http: changed.meta });
}

async function signedRequest(
  auth: OvhConfig,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: Record<string, unknown>,
) {
  const base = BASE[auth.endpoint];
  const body = payload ? JSON.stringify(payload) : '';
  const time = await request(`${base}/auth/time`);
  if (!time.response.ok) {
    throw new Error(`OVH time sync failed (HTTP ${time.meta.status})`);
  }
  const timestamp = Number(time.body);
  if (!Number.isFinite(timestamp)) {
    throw new Error('OVH time sync returned a non-numeric timestamp');
  }
  const url = `${base}${path}`;
  const signature = `$1$${createHash('sha1')
    .update(`${auth.applicationSecret}+${auth.consumerKey}+${method}+${url}+${body}+${timestamp}`)
    .digest('hex')}`;
  return await request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Ovh-Application': auth.applicationKey!,
      'X-Ovh-Consumer': auth.consumerKey!,
      'X-Ovh-Timestamp': String(timestamp),
      'X-Ovh-Signature': signature,
    },
    ...(body ? { body } : {}),
  });
}
