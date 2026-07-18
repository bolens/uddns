/**
 * DigitalOcean DNS provider (Domains API v2).
 */

import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { deriveTwoLabelApex, normalizeDnsName, splitDomainHost } from './domain-host.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request, throwWithHttpMeta, type RequestMeta } from './http.js';

const API = 'https://api.digitalocean.com/v2';

const doRecordSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  data: z.string(),
});
type DoRecord = z.infer<typeof doRecordSchema>;

const doRecordsResponseSchema = z.object({
  domain_records: z.array(doRecordSchema),
});

export const digitaloceanProvider: Provider = {
  id: 'digitalocean',
  label: 'DigitalOcean',
  async update(config, ip) {
    const dio = config.digitalocean;
    const hostname = config.hostname;

    const missing = requireFields('digitalocean requires DIGITALOCEAN_API_TOKEN', [dio.apiToken], {
      hasApiToken: Boolean(dio.apiToken),
    });
    if (missing) {
      return missing;
    }

    if (!hostname) {
      return fail('digitalocean requires UDDNS_HOST or UDDNS_HOSTS');
    }

    if (!ip.v4 && !ip.v6) {
      return fail('No public IP available', { hostname, ip });
    }

    const domain = dio.domain ? normalizeDnsName(dio.domain) : deriveDomain(hostname);
    if (!domain) {
      return fail(
        `Cannot determine DigitalOcean domain for "${hostname}". Set DIGITALOCEAN_DOMAIN.`,
        {
          hostname,
          hint: 'Use an FQDN in UDDNS_HOSTS or set DIGITALOCEAN_DOMAIN to the registered domain',
        },
      );
    }

    const record = splitDomainHost(hostname, domain);
    if (!record) {
      return fail(`Host ${hostname} is not within DigitalOcean domain ${domain}`, {
        hostname,
        domain,
      });
    }
    const recordName = record.name;

    const apiToken = dio.apiToken!;
    const results: UpdateResult[] = [];

    if (ip.v4) {
      results.push(await upsertRecord(apiToken, domain, recordName, 'A', ip.v4));
    }
    if (ip.v6) {
      results.push(await upsertRecord(apiToken, domain, recordName, 'AAAA', ip.v6));
    }

    return combineRecordResults(results, {
      domain,
      recordName,
      hostname,
    });
  },
};

function deriveDomain(hostname: string): string | null {
  return deriveTwoLabelApex(hostname)?.domain ?? null;
}

async function upsertRecord(
  apiToken: string,
  domain: string,
  recordName: string,
  type: 'A' | 'AAAA',
  content: string,
): Promise<UpdateResult> {
  const fqdn = recordName === '@' ? domain : `${recordName}.${domain}`;
  const record = await findRecord(apiToken, domain, fqdn, type);

  if (record && record.data === content) {
    return skipped(`${type} ${fqdn} unchanged (${content})`, {
      domain,
      recordId: record.id,
      type,
      name: recordName,
      content,
      action: 'unchanged',
    });
  }

  if (record) {
    const updated = await digitaloceanJson(
      apiToken,
      `${API}/domains/${domain}/records/${record.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({ type, data: content }),
      },
    );

    if (updated.response.ok) {
      return ok(`${type} ${fqdn} -> ${content}`, {
        domain,
        recordId: record.id,
        type,
        name: recordName,
        previous: record.data,
        content,
        action: 'update',
        http: updated.meta,
      });
    }

    return fail(formatDigitalOceanError(updated), {
      domain,
      recordId: record.id,
      type,
      name: recordName,
      content,
      action: 'update',
      http: updated.meta,
    });
  }

  const created = await digitaloceanJson(apiToken, `${API}/domains/${domain}/records`, {
    method: 'POST',
    body: JSON.stringify({ type, name: recordName, data: content }),
  });

  if (created.response.ok) {
    return ok(`Created ${type} ${fqdn} -> ${content}`, {
      domain,
      type,
      name: recordName,
      content,
      action: 'create',
      http: created.meta,
    });
  }

  return fail(formatDigitalOceanError(created), {
    domain,
    type,
    name: recordName,
    content,
    action: 'create',
    http: created.meta,
  });
}

async function findRecord(
  apiToken: string,
  domain: string,
  fqdn: string,
  type: 'A' | 'AAAA',
): Promise<DoRecord | null> {
  const url = new URL(`${API}/domains/${domain}/records`);
  url.searchParams.set('type', type);
  url.searchParams.set('name', fqdn);
  url.searchParams.set('per_page', '100');

  const payload = await digitaloceanJson(apiToken, url);
  if (!payload.response.ok) {
    const error = new Error(
      `DigitalOcean ${type} record lookup for ${fqdn} failed: ${formatDigitalOceanError(payload)}`,
    );
    Object.assign(error, {
      status: payload.meta.status,
      details: { http: payload.meta },
      retryAfterMs: payload.meta.retryAfterMs,
    });
    throw error;
  }

  const parsed = doRecordsResponseSchema.safeParse(payload.data);
  if (!parsed.success) {
    throw new Error(`DigitalOcean records response failed validation: ${parsed.error.message}`);
  }

  const matches = parsed.data.domain_records.filter((entry) =>
    digitalOceanNameMatches(entry.name, fqdn, domain),
  );
  if (matches.length > 1) {
    const error = new Error(
      `Multiple ${type} records for ${fqdn}; remove duplicates before updating`,
    );
    Object.assign(error, {
      details: { domain, type, fqdn, count: matches.length },
    });
    throw error;
  }

  return matches[0] ?? null;
}

function digitalOceanNameMatches(returned: string, fqdn: string, domain: string): boolean {
  const name = normalizeDnsName(returned);
  const target = normalizeDnsName(fqdn);
  const apex = normalizeDnsName(domain);
  if (name === target) {
    return true;
  }
  if (name === '@' && target === apex) {
    return true;
  }
  if (target === apex && (name === '@' || name === apex)) {
    return true;
  }
  if (target.endsWith(`.${apex}`)) {
    const relative = target.slice(0, -(apex.length + 1));
    return name === relative;
  }
  return false;
}

type DigitalOceanPayload = {
  response: Response;
  data: unknown;
  meta: RequestMeta;
};

async function digitaloceanJson(
  apiToken: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<DigitalOceanPayload> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  headers.set('Content-Type', 'application/json');

  const { response, body, meta } = await request(url, { ...init, headers });

  let data: unknown = null;
  if (body.trim() !== '') {
    try {
      data = JSON.parse(body);
    } catch {
      throwWithHttpMeta(
        `DigitalOcean returned non-JSON (${response.status} ${response.statusText}) from ${meta.url}: ${meta.bodyPreview}`,
        meta,
      );
    }
  }

  return { response, data, meta };
}

const doErrorSchema = z.object({
  id: z.string().optional(),
  message: z.string().optional(),
});

function formatDigitalOceanError(payload: DigitalOceanPayload): string {
  const parsed = doErrorSchema.safeParse(payload.data);
  if (parsed.success && parsed.data.message) {
    return parsed.data.id ? `${parsed.data.message} [${parsed.data.id}]` : parsed.data.message;
  }
  return `DigitalOcean API request failed (HTTP ${payload.meta.status} ${payload.meta.statusText})`;
}
