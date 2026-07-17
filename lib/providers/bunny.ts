import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request } from './http.js';

const zoneSchema = z.object({
  Records: z.array(
    z.object({
      Id: z.number(),
      Type: z.number(),
      Name: z.string(),
      Value: z.string(),
      Ttl: z.number(),
    }),
  ),
});

export const bunnyProvider: Provider = {
  id: 'bunny',
  label: 'bunny.net DNS',
  async update(config, ip) {
    const auth = config.bunny;
    const missing = requireFields('bunny requires BUNNY_API_KEY, BUNNY_ZONE_ID, and BUNNY_DOMAIN', [
      auth.apiKey,
      auth.zoneId,
      auth.domain,
    ]);
    if (missing) return missing;
    if (!config.hostname) return fail('bunny requires UDDNS_HOST or UDDNS_HOSTS');
    const host = splitDomainHost(config.hostname, auth.domain);
    if (!host) return fail(`Host ${config.hostname} is outside BUNNY_DOMAIN`);
    const headers = { AccessKey: auth.apiKey!, 'Content-Type': 'application/json' };
    const zone = await request(`https://api.bunny.net/dnszone/${auth.zoneId}`, { headers });
    const parsed = zoneSchema.safeParse(JSON.parse(zone.body));
    if (!zone.response.ok || !parsed.success)
      return fail('Bunny DNS zone lookup failed', { http: zone.meta });
    const results: UpdateResult[] = [];
    if (ip.v4)
      results.push(
        await upsert(
          auth.zoneId!,
          headers,
          parsed.data.Records,
          host.name,
          0,
          'A',
          ip.v4,
          auth.ttl,
        ),
      );
    if (ip.v6)
      results.push(
        await upsert(
          auth.zoneId!,
          headers,
          parsed.data.Records,
          host.name,
          1,
          'AAAA',
          ip.v6,
          auth.ttl,
        ),
      );
    return results.length ? combineRecordResults(results, host) : fail('No public IP available');
  },
};

async function upsert(
  zoneId: number,
  headers: Record<string, string>,
  records: z.infer<typeof zoneSchema>['Records'],
  name: string,
  typeCode: number,
  type: 'A' | 'AAAA',
  value: string,
  ttl: number,
): Promise<UpdateResult> {
  const label = name === '@' ? '' : name;
  const record = records.find((item) => item.Type === typeCode && item.Name === label);
  if (record?.Value === value && record.Ttl === ttl)
    return skipped(`${type} ${name} unchanged (${value})`);
  const base = `https://api.bunny.net/dnszone/${zoneId}/records`;
  const changed = await request(record ? `${base}/${record.Id}` : base, {
    method: record ? 'POST' : 'PUT',
    headers,
    body: JSON.stringify({ Type: typeCode, Name: label, Value: value, Ttl: ttl }),
  });
  return changed.response.ok
    ? ok(`${type} ${name} -> ${value}`, { http: changed.meta })
    : fail(`Bunny record update failed (HTTP ${changed.meta.status})`, { http: changed.meta });
}
