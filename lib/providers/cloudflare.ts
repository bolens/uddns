/**
 * Cloudflare DNS provider.
 */

import { fail, ok, skipped } from '../result.js';
import type { JsonObject } from '../schemas/json.js';
import {
  cloudflareDnsRecordSchema,
  cloudflareEnvelopeSchema,
  cloudflareRecordResponseSchema,
  cloudflareRecordsResponseSchema,
  cloudflareZonesResponseSchema,
  type CloudflareDnsRecord,
  type CloudflareEnvelope,
  type CloudflareError,
} from '../schemas/cloudflare.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { request, throwWithHttpMeta, type RequestMeta } from './http.js';

const API = 'https://api.cloudflare.com/client/v4';

function normalizeDnsLabel(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

type CloudflarePayload = CloudflareEnvelope & {
  meta?: RequestMeta;
};

function errorsToJson(errors: CloudflareError[] | undefined): JsonObject[] | null {
  if (!errors) {
    return null;
  }

  return errors.map((error) => ({
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.message === undefined ? {} : { message: error.message }),
  }));
}

export const cloudflareProvider: Provider = {
  id: 'cloudflare',
  label: 'Cloudflare',
  async update(config, ip) {
    const cf = config.cloudflare;
    const apiToken = cf.apiToken;
    const recordName = cf.recordName ? normalizeDnsLabel(cf.recordName) : cf.recordName;
    const zoneName = cf.zoneName ? normalizeDnsLabel(cf.zoneName) : cf.zoneName;

    if (!apiToken) {
      return fail('cloudflare requires CLOUDFLARE_API_TOKEN', {
        hint: 'Create a token with Zone → DNS → Edit (and Zone → Zone → Read for name lookup)',
      });
    }

    if (!recordName) {
      return fail('cloudflare requires CLOUDFLARE_RECORD_NAME, UDDNS_HOST, or UDDNS_HOSTS');
    }

    if (!ip.v4 && !ip.v6) {
      return fail('No public IP available', { recordName, ip });
    }

    const zoneId = cf.zoneId ?? (await resolveZoneId(apiToken, zoneName, recordName));
    if (!zoneId) {
      return fail(
        'Could not resolve Cloudflare zone. Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME.',
        {
          recordName,
          zoneName,
          hint: 'Zone name is usually the apex domain (example.com), not the subdomain',
        },
      );
    }

    const results: UpdateResult[] = [];

    if (ip.v4) {
      results.push(
        await upsertRecord({
          apiToken,
          zoneId,
          recordId: cf.recordId,
          name: recordName,
          type: 'A',
          content: ip.v4,
          proxied: cf.proxied,
          ttl: cf.ttl,
          createIfMissing: cf.createIfMissing,
        }),
      );
    }

    if (ip.v6) {
      results.push(
        await upsertRecord({
          apiToken,
          zoneId,
          recordId: null,
          name: recordName,
          type: 'AAAA',
          content: ip.v6,
          proxied: cf.proxied,
          ttl: cf.ttl,
          createIfMissing: cf.createIfMissing,
        }),
      );
    }

    const message = results.map((result) => result.message).join('; ');
    const details: JsonObject = {
      zoneId,
      recordName,
      proxied: cf.proxied,
      ttl: cf.ttl,
      results: results.map((result) => ({
        ok: result.ok,
        skipped: result.skipped ?? false,
        message: result.message,
        details: result.details ?? null,
      })),
    };

    if (results.some((result) => !result.ok)) {
      return fail(message, details);
    }

    if (results.every((result) => result.skipped)) {
      return skipped(message, details);
    }

    return ok(message, details);
  },
};

async function resolveZoneId(
  apiToken: string,
  zoneName: string | null,
  recordName: string,
): Promise<string | null> {
  if (zoneName) {
    const zones = await listZones(apiToken, zoneName);
    return zones[0]?.id ?? null;
  }

  const labels = recordName.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    const zones = await listZones(apiToken, candidate);
    if (zones[0]?.id) {
      return zones[0].id;
    }
  }

  return null;
}

async function listZones(apiToken: string, name: string) {
  const url = new URL(`${API}/zones`);
  url.searchParams.set('name', name);
  url.searchParams.set('status', 'active');
  url.searchParams.set('per_page', '1');

  const payload = await cloudflareJson(apiToken, url);
  assertCloudflareSuccess(payload, `zone lookup for ${name}`);
  return parseCloudflare(cloudflareZonesResponseSchema, payload, 'zones').result ?? [];
}

type UpsertOptions = {
  apiToken: string;
  zoneId: string;
  recordId: string | null;
  name: string;
  type: 'A' | 'AAAA';
  content: string;
  proxied: boolean;
  ttl: number;
  createIfMissing: boolean;
};

async function upsertRecord(options: UpsertOptions): Promise<UpdateResult> {
  const { apiToken, zoneId, recordId, name, type, content, proxied, ttl, createIfMissing } =
    options;

  const record = recordId
    ? await getRecord(apiToken, zoneId, recordId).then(async (pinned) => {
        if (!pinned) {
          return null;
        }
        const typeMismatch = pinned.type !== undefined && pinned.type !== type;
        const nameMismatch =
          pinned.name !== undefined && normalizeDnsLabel(pinned.name) !== normalizeDnsLabel(name);
        // Stale/wrong CLOUDFLARE_RECORD_ID must not PATCH another hostname onto `name`.
        if (typeMismatch || nameMismatch) {
          return await findRecord(apiToken, zoneId, name, type);
        }
        return pinned;
      })
    : await findRecord(apiToken, zoneId, name, type);

  const desiredTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : 1;
  if (
    record &&
    record.content === content &&
    record.proxied === proxied &&
    (record.ttl === undefined || record.ttl === desiredTtl)
  ) {
    return skipped(`${type} ${name} unchanged (${content})`, {
      zoneId,
      recordId: record.id,
      type,
      name,
      content,
      proxied,
      ttl: desiredTtl,
      action: 'unchanged',
    });
  }

  const body = {
    type,
    name,
    content,
    ttl: desiredTtl,
    proxied,
  };

  if (record) {
    const updated = await cloudflareJson(
      apiToken,
      `${API}/zones/${zoneId}/dns_records/${record.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );

    if (updated.success) {
      return ok(`${type} ${name} -> ${content}`, {
        zoneId,
        recordId: record.id,
        type,
        name,
        previous: record.content,
        content,
        proxied,
        action: 'patch',
        http: updated.meta ?? null,
      });
    }

    return fail(formatCloudflareError(updated), {
      zoneId,
      recordId: record.id,
      type,
      name,
      content,
      action: 'patch',
      http: updated.meta ?? null,
      errors: errorsToJson(updated.errors),
    });
  }

  if (!createIfMissing) {
    return fail(`${type} record for ${name} not found`, {
      zoneId,
      type,
      name,
      createIfMissing,
      hint: 'Create the record in Cloudflare or set CLOUDFLARE_CREATE_IF_MISSING=true',
    });
  }

  const created = await cloudflareJson(apiToken, `${API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (created.success) {
    return ok(`Created ${type} ${name} -> ${content}`, {
      zoneId,
      type,
      name,
      content,
      proxied,
      action: 'create',
      http: created.meta ?? null,
    });
  }

  return fail(formatCloudflareError(created), {
    zoneId,
    type,
    name,
    content,
    action: 'create',
    http: created.meta ?? null,
    errors: errorsToJson(created.errors),
  });
}

async function getRecord(
  apiToken: string,
  zoneId: string,
  recordId: string,
): Promise<CloudflareDnsRecord | null> {
  const payload = await cloudflareJson(apiToken, `${API}/zones/${zoneId}/dns_records/${recordId}`);
  assertCloudflareSuccess(payload, `record lookup for ${recordId}`);
  const parsed = parseCloudflare(cloudflareRecordResponseSchema, payload, 'record');
  if (parsed.result == null) {
    return null;
  }
  return cloudflareDnsRecordSchema.parse(parsed.result);
}

async function findRecord(
  apiToken: string,
  zoneId: string,
  name: string,
  type: 'A' | 'AAAA',
): Promise<CloudflareDnsRecord | null> {
  const url = new URL(`${API}/zones/${zoneId}/dns_records`);
  url.searchParams.set('type', type);
  url.searchParams.set('name', name);
  url.searchParams.set('per_page', '1');

  const payload = await cloudflareJson(apiToken, url);
  assertCloudflareSuccess(payload, `${type} record lookup for ${name}`);
  return parseCloudflare(cloudflareRecordsResponseSchema, payload, 'records').result?.[0] ?? null;
}

async function cloudflareJson(
  apiToken: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<CloudflarePayload> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  headers.set('Content-Type', 'application/json');

  const { response, body, meta } = await request(url, { ...init, headers });

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    throwWithHttpMeta(
      `Cloudflare returned non-JSON (${response.status} ${response.statusText}) from ${meta.url}: ${meta.bodyPreview}`,
      meta,
    );
  }

  const parsed = cloudflareEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(`Cloudflare returned invalid JSON from ${meta.url}: ${parsed.error.message}`);
  }

  const payload: CloudflarePayload = { ...parsed.data, meta };

  if (!response.ok && payload.success !== false) {
    payload.success = false;
    payload.errors ??= [
      {
        message: `HTTP ${response.status} ${response.statusText}`,
      },
    ];
  }

  return payload;
}

function parseCloudflare<T>(
  schema: {
    safeParse: (
      payload: unknown,
    ) => { success: true; data: T } | { success: false; error: { message: string } };
  },
  payload: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Cloudflare ${label} response failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function formatCloudflareError(payload: CloudflarePayload): string {
  const parts =
    payload.errors
      ?.map((error) => {
        if (error.code != null && error.message) {
          return `${error.message} [code ${error.code}]`;
        }
        return error.message;
      })
      .filter((value): value is string => Boolean(value)) ?? [];

  if (parts.length > 0) {
    return parts.join('; ');
  }

  if (payload.meta) {
    return `Cloudflare API request failed (HTTP ${payload.meta.status} ${payload.meta.statusText})`;
  }

  /* v8 ignore next: defensive fallback; cloudflareJson always attaches meta */
  return 'Cloudflare API request failed';
}

function assertCloudflareSuccess(payload: CloudflarePayload, operation: string): void {
  if (payload.success !== false) {
    return;
  }
  const error = new Error(`Cloudflare ${operation} failed: ${formatCloudflareError(payload)}`);
  if (payload.meta) {
    Object.assign(error, {
      status: payload.meta.status,
      details: { http: payload.meta },
      retryAfterMs: payload.meta.retryAfterMs,
    });
  }
  throw error;
}
