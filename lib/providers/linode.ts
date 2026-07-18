import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost, normalizeDnsName } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request } from './http.js';

const domainSchema = z.object({
  id: z.number(),
  domain: z.string(),
});

const recordsSchema = z.object({
  data: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      name: z.string(),
      target: z.string(),
      ttl_sec: z.number().optional(),
    }),
  ),
});

export const linodeProvider: Provider = {
  id: 'linode',
  label: 'Akamai Connected Cloud (Linode)',
  async update(config, ip) {
    const auth = config.linode;
    const missing = requireFields(
      'linode requires LINODE_API_TOKEN, LINODE_DOMAIN_ID, and LINODE_DOMAIN',
      [auth.apiToken, auth.domainId, auth.domain],
    );
    if (missing) return missing;
    if (!config.hostname) return fail('linode requires UDDNS_HOST or UDDNS_HOSTS');
    if (!ip.v4 && !ip.v6) return fail('No public IP available');
    const headers = {
      Authorization: `Bearer ${auth.apiToken!}`,
      'Content-Type': 'application/json',
    };
    const domainLookup = await request(`https://api.linode.com/v4/domains/${auth.domainId}`, {
      headers,
    });
    if (!domainLookup.response.ok) {
      return fail(`Linode domain lookup failed (HTTP ${domainLookup.meta.status})`, {
        http: domainLookup.meta,
      });
    }
    let domainParsed: ReturnType<typeof domainSchema.safeParse> | null = null;
    try {
      domainParsed = domainSchema.safeParse(JSON.parse(domainLookup.body));
    } catch {
      return fail('Linode returned invalid domain data', { http: domainLookup.meta });
    }
    if (!domainParsed.success) {
      return fail('Linode returned invalid domain data', { http: domainLookup.meta });
    }
    const apiDomain = normalizeDnsName(domainParsed.data.domain);
    const configuredDomain = normalizeDnsName(auth.domain!);
    // Domain ID is authoritative for writes; refuse when LINODE_DOMAIN points elsewhere.
    if (apiDomain !== configuredDomain) {
      return fail(
        `Linode domain ${auth.domainId} is "${apiDomain}", not LINODE_DOMAIN "${configuredDomain}"`,
        {
          domainId: auth.domainId,
          domain: configuredDomain,
          apiDomain,
        },
      );
    }
    const host = splitDomainHost(config.hostname, apiDomain);
    if (!host) return fail(`Host ${config.hostname} is outside LINODE_DOMAIN`);
    const results: UpdateResult[] = [];
    if (ip.v4)
      results.push(await upsert(auth.apiToken!, auth.domainId!, host.name, 'A', ip.v4, auth.ttl));
    if (ip.v6)
      results.push(
        await upsert(auth.apiToken!, auth.domainId!, host.name, 'AAAA', ip.v6, auth.ttl),
      );
    return results.length ? combineRecordResults(results, host) : fail('No public IP available');
  },
};

async function upsert(
  token: string,
  domainId: number,
  name: string,
  type: 'A' | 'AAAA',
  target: string,
  ttl: number,
): Promise<UpdateResult> {
  const apiName = name === '@' ? '' : name;
  const base = `https://api.linode.com/v4/domains/${domainId}/records`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const listed = await request(`${base}?type=${type}&name=${encodeURIComponent(apiName)}`, {
    headers,
  });
  if (!listed.response.ok) {
    return fail(`Linode record lookup failed (HTTP ${listed.meta.status})`, { http: listed.meta });
  }
  let parsed: ReturnType<typeof recordsSchema.safeParse> | null = null;
  try {
    parsed = recordsSchema.safeParse(JSON.parse(listed.body));
  } catch {
    return fail('Linode returned invalid record data', { http: listed.meta });
  }
  if (!parsed.success) return fail('Linode returned invalid record data', { http: listed.meta });
  const record = parsed.data.data.find(
    (item) => item.type === type && normalizeDnsName(item.name) === normalizeDnsName(apiName),
  );
  if (record?.target === target && record.ttl_sec === ttl) {
    return skipped(`${type} ${name} unchanged (${target})`);
  }
  const changed = await request(record ? `${base}/${record.id}` : base, {
    method: record ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify({ type, name: apiName, target, ttl_sec: ttl }),
  });
  return changed.response.ok
    ? ok(`${type} ${name} -> ${target}`, { http: changed.meta })
    : fail(`Linode record update failed (HTTP ${changed.meta.status})`, { http: changed.meta });
}
