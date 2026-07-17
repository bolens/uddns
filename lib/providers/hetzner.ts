/**
 * Hetzner DNS provider (dns.hetzner.com API v1).
 */

import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request, type RequestMeta } from './http.js';
import { normalizeDnsName } from './domain-host.js';

const API = 'https://dns.hetzner.com/api/v1';

const hetznerZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
});
type HetznerZone = z.infer<typeof hetznerZoneSchema>;

const hetznerZonesResponseSchema = z.object({
  zones: z.array(hetznerZoneSchema),
});

const hetznerZoneResponseSchema = z.object({
  zone: hetznerZoneSchema,
});

const hetznerRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  value: z.string(),
});
type HetznerRecord = z.infer<typeof hetznerRecordSchema>;

const hetznerRecordsResponseSchema = z.object({
  records: z.array(hetznerRecordSchema).optional(),
});

export const hetznerProvider: Provider = {
  id: 'hetzner',
  label: 'Hetzner DNS',
  async update(config, ip) {
    const hz = config.hetzner;
    const hostname = config.hostname;

    const missing = requireFields('hetzner requires HETZNER_API_TOKEN', [hz.apiToken], {
      hasApiToken: Boolean(hz.apiToken),
    });
    if (missing) {
      return missing;
    }

    if (!hostname) {
      return fail('hetzner requires UDDNS_HOST or UDDNS_HOSTS');
    }

    if (!ip.v4 && !ip.v6) {
      return fail('No public IP available', { hostname, ip });
    }

    const apiToken = hz.apiToken!;
    const zone = await resolveZone(apiToken, hz.zoneId, hz.zoneName, hostname);
    if (!zone) {
      return fail('Could not resolve Hetzner zone. Set HETZNER_ZONE_ID or HETZNER_ZONE_NAME.', {
        hostname,
        zoneName: hz.zoneName,
        hint: 'Zone name is usually the apex domain (example.com), not the subdomain',
      });
    }

    const recordName = relativeRecordName(hostname, zone.name);
    if (!recordName) {
      return fail(`Host ${hostname} is not within Hetzner zone ${zone.name}`, {
        hostname,
        zoneId: zone.id,
        zoneName: zone.name,
      });
    }

    const results: UpdateResult[] = [];

    if (ip.v4) {
      results.push(await upsertRecord(apiToken, zone, recordName, 'A', ip.v4));
    }
    if (ip.v6) {
      results.push(await upsertRecord(apiToken, zone, recordName, 'AAAA', ip.v6));
    }

    return combineRecordResults(results, {
      zoneId: zone.id,
      zoneName: zone.name,
      recordName,
      hostname,
    });
  },
};

async function resolveZone(
  apiToken: string,
  zoneId: string | null,
  zoneName: string | null,
  hostname: string,
): Promise<HetznerZone | null> {
  if (zoneId) {
    const payload = await hetznerJson(apiToken, `${API}/zones/${zoneId}`);
    if (!payload.response.ok) {
      const error = new Error(
        `Hetzner zone lookup for ${zoneId} failed: ${formatHetznerError(payload)}`,
      );
      Object.assign(error, {
        status: payload.meta.status,
        details: { http: payload.meta },
        retryAfterMs: payload.meta.retryAfterMs,
      });
      throw error;
    }
    return parseHetzner(hetznerZoneResponseSchema, payload, 'zone').zone;
  }

  if (zoneName) {
    return await findZoneByName(apiToken, normalizeDnsName(zoneName));
  }

  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    const zone = await findZoneByName(apiToken, candidate);
    if (zone) {
      return zone;
    }
  }

  return null;
}

async function findZoneByName(apiToken: string, name: string): Promise<HetznerZone | null> {
  const url = new URL(`${API}/zones`);
  url.searchParams.set('name', name);

  const payload = await hetznerJson(apiToken, url);
  // Hetzner answers zone-name searches with 404 when nothing matches.
  if (payload.response.status === 404) {
    return null;
  }
  if (!payload.response.ok) {
    const error = new Error(
      `Hetzner zone lookup for ${name} failed: ${formatHetznerError(payload)}`,
    );
    Object.assign(error, {
      status: payload.meta.status,
      details: { http: payload.meta },
      retryAfterMs: payload.meta.retryAfterMs,
    });
    throw error;
  }

  return parseHetzner(hetznerZonesResponseSchema, payload, 'zones').zones[0] ?? null;
}

/** Hetzner records are named relative to the zone: `@` for the apex. */
function relativeRecordName(hostname: string, zoneName: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const zone = zoneName.toLowerCase().replace(/\.$/, '');
  if (host === zone) {
    return '@';
  }
  if (host.endsWith(`.${zone}`)) {
    return host.slice(0, -(zone.length + 1));
  }
  return null;
}

async function upsertRecord(
  apiToken: string,
  zone: HetznerZone,
  recordName: string,
  type: 'A' | 'AAAA',
  content: string,
): Promise<UpdateResult> {
  const fqdn = recordName === '@' ? zone.name : `${recordName}.${zone.name}`;
  const record = await findRecord(apiToken, zone.id, recordName, type);

  if (record && record.value === content) {
    return skipped(`${type} ${fqdn} unchanged (${content})`, {
      zoneId: zone.id,
      recordId: record.id,
      type,
      name: recordName,
      content,
      action: 'unchanged',
    });
  }

  const body = JSON.stringify({
    zone_id: zone.id,
    type,
    name: recordName,
    value: content,
  });

  if (record) {
    const updated = await hetznerJson(apiToken, `${API}/records/${record.id}`, {
      method: 'PUT',
      body,
    });

    if (updated.response.ok) {
      return ok(`${type} ${fqdn} -> ${content}`, {
        zoneId: zone.id,
        recordId: record.id,
        type,
        name: recordName,
        previous: record.value,
        content,
        action: 'update',
        http: updated.meta,
      });
    }

    return fail(formatHetznerError(updated), {
      zoneId: zone.id,
      recordId: record.id,
      type,
      name: recordName,
      content,
      action: 'update',
      http: updated.meta,
    });
  }

  const created = await hetznerJson(apiToken, `${API}/records`, {
    method: 'POST',
    body,
  });

  if (created.response.ok) {
    return ok(`Created ${type} ${fqdn} -> ${content}`, {
      zoneId: zone.id,
      type,
      name: recordName,
      content,
      action: 'create',
      http: created.meta,
    });
  }

  return fail(formatHetznerError(created), {
    zoneId: zone.id,
    type,
    name: recordName,
    content,
    action: 'create',
    http: created.meta,
  });
}

async function findRecord(
  apiToken: string,
  zoneId: string,
  name: string,
  type: 'A' | 'AAAA',
): Promise<HetznerRecord | null> {
  let page = 1;
  for (;;) {
    const url = new URL(`${API}/records`);
    url.searchParams.set('zone_id', zoneId);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');

    const payload = await hetznerJson(apiToken, url);
    if (!payload.response.ok) {
      const error = new Error(
        `Hetzner ${type} record lookup for ${name} failed: ${formatHetznerError(payload)}`,
      );
      Object.assign(error, {
        status: payload.meta.status,
        details: { http: payload.meta },
        retryAfterMs: payload.meta.retryAfterMs,
      });
      throw error;
    }

    const records = parseHetzner(hetznerRecordsResponseSchema, payload, 'records').records ?? [];
    const match = records.find((record) => record.type === type && record.name === name) ?? null;
    if (match) {
      return match;
    }
    if (records.length < 100 || page >= 50) {
      return null;
    }
    page += 1;
  }
}

type HetznerPayload = {
  response: Response;
  data: unknown;
  meta: RequestMeta;
};

async function hetznerJson(
  apiToken: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<HetznerPayload> {
  const headers = new Headers(init.headers);
  headers.set('Auth-API-Token', apiToken);
  headers.set('Content-Type', 'application/json');

  const { response, body, meta } = await request(url, { ...init, headers });

  let data: unknown = null;
  if (body.trim() !== '') {
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(
        `Hetzner returned non-JSON (${response.status} ${response.statusText}) from ${meta.url}: ${meta.bodyPreview}`,
      );
    }
  }

  return { response, data, meta };
}

function parseHetzner<T>(
  schema: {
    safeParse: (
      payload: unknown,
    ) => { success: true; data: T } | { success: false; error: { message: string } };
  },
  payload: HetznerPayload,
  label: string,
): T {
  const parsed = schema.safeParse(payload.data);
  if (!parsed.success) {
    throw new Error(`Hetzner ${label} response failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

const hetznerErrorSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional(), code: z.number().optional() }).optional(),
});

function formatHetznerError(payload: HetznerPayload): string {
  const parsed = hetznerErrorSchema.safeParse(payload.data);
  if (parsed.success) {
    const message = parsed.data.error?.message ?? parsed.data.message;
    if (message) {
      const code = parsed.data.error?.code;
      return code === undefined ? message : `${message} [code ${code}]`;
    }
  }
  return `Hetzner API request failed (HTTP ${payload.meta.status} ${payload.meta.statusText})`;
}
