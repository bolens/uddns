import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { splitDomainHost, normalizeDnsName } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request } from './http.js';

const zoneSchema = z.object({
  Domain: z.string(),
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
    if (!ip.v4 && !ip.v6) return fail('No public IP available');
    const headers = { AccessKey: auth.apiKey!, 'Content-Type': 'application/json' };
    const zone = await request(`https://api.bunny.net/dnszone/${auth.zoneId}`, { headers });
    if (!zone.response.ok) {
      return fail('Bunny DNS zone lookup failed', { http: zone.meta });
    }
    let parsed: ReturnType<typeof zoneSchema.safeParse> | null = null;
    try {
      parsed = zoneSchema.safeParse(JSON.parse(zone.body));
    } catch {
      return fail('Bunny DNS zone lookup failed', { http: zone.meta });
    }
    if (!parsed.success) {
      return fail('Bunny DNS zone lookup failed', { http: zone.meta });
    }
    const zoneDomain = normalizeDnsName(parsed.data.Domain);
    const configuredDomain = normalizeDnsName(auth.domain!);
    // Zone ID is authoritative for writes; refuse when BUNNY_DOMAIN points elsewhere.
    if (zoneDomain !== configuredDomain) {
      return fail(
        `Bunny zone ${auth.zoneId} is "${zoneDomain}", not BUNNY_DOMAIN "${configuredDomain}"`,
        {
          zoneId: auth.zoneId,
          domain: configuredDomain,
          zoneDomain,
        },
      );
    }
    const host = splitDomainHost(config.hostname, zoneDomain);
    if (!host) return fail(`Host ${config.hostname} is outside BUNNY_DOMAIN`);
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
  const record = records.find(
    (item) => item.Type === typeCode && normalizeDnsName(item.Name) === normalizeDnsName(label),
  );
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
