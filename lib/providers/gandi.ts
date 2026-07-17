import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { combineRecordResults, requireFields } from './guards.js';
import { splitDomainHost } from './domain-host.js';
import { request } from './http.js';

const recordSchema = z.object({
  rrset_values: z.array(z.string()),
  rrset_ttl: z.number().optional(),
});

export const gandiProvider: Provider = {
  id: 'gandi',
  label: 'Gandi LiveDNS',
  async update(config, ip) {
    const auth = config.gandi;
    const missing = requireFields('gandi requires GANDI_API_TOKEN and GANDI_DOMAIN', [
      auth.apiToken,
      auth.domain,
    ]);
    if (missing) return missing;
    if (!config.hostname) return fail('gandi requires UDDNS_HOST or UDDNS_HOSTS');
    const host = splitDomainHost(config.hostname, auth.domain);
    if (!host) return fail(`Host ${config.hostname} is outside GANDI_DOMAIN`);
    const results: UpdateResult[] = [];
    if (ip.v4) results.push(await upsert(auth.apiToken!, host, 'A', ip.v4, auth.ttl));
    if (ip.v6) results.push(await upsert(auth.apiToken!, host, 'AAAA', ip.v6, auth.ttl));
    return results.length
      ? combineRecordResults(results, host)
      : fail('No public IP available', { hostname: config.hostname });
  },
};

async function upsert(
  token: string,
  host: { domain: string; name: string },
  type: 'A' | 'AAAA',
  value: string,
  ttl: number,
): Promise<UpdateResult> {
  const name = host.name === '@' ? '@' : host.name;
  const url = `https://api.gandi.net/v5/livedns/domains/${encodeURIComponent(host.domain)}/records/${encodeURIComponent(name)}/${type}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const current = await request(url, { headers });
  if (current.response.ok) {
    const parsed = recordSchema.safeParse(JSON.parse(current.body));
    if (!parsed.success) return fail(`Gandi returned invalid ${type} record data`);
    if (
      parsed.data.rrset_values.length === 1 &&
      parsed.data.rrset_values[0] === value &&
      parsed.data.rrset_ttl === ttl
    ) {
      return skipped(`${type} ${name}.${host.domain} unchanged (${value})`);
    }
  } else if (current.response.status !== 404) {
    return fail(`Gandi record lookup failed (HTTP ${current.meta.status})`, {
      http: current.meta,
    });
  }
  const updated = await request(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ rrset_ttl: ttl, rrset_values: [value] }),
  });
  return updated.response.ok
    ? ok(`${type} ${name}.${host.domain} -> ${value}`, { http: updated.meta })
    : fail(`Gandi record update failed (HTTP ${updated.meta.status})`, { http: updated.meta });
}
