/**
 * Porkbun DNS provider (JSON API v3).
 */

import { z } from 'zod';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request, type RequestMeta } from './http.js';

const API = 'https://api.porkbun.com/api/json/v3';

const porkbunRecordSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  type: z.string(),
  content: z.string(),
});
type PorkbunRecord = z.infer<typeof porkbunRecordSchema>;

const porkbunEnvelopeSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  records: z.array(porkbunRecordSchema).optional(),
});

export const porkbunProvider: Provider = {
  id: 'porkbun',
  label: 'Porkbun',
  async update(config, ip) {
    const pb = config.porkbun;
    const hostname = config.hostname;

    const missing = requireFields(
      'porkbun requires PORKBUN_API_KEY and PORKBUN_SECRET_KEY',
      [pb.apiKey, pb.secretKey],
      {
        hasApiKey: Boolean(pb.apiKey),
        hasSecretKey: Boolean(pb.secretKey),
      },
    );
    if (missing) {
      return missing;
    }

    if (!hostname) {
      return fail('porkbun requires UDDNS_HOST or UDDNS_HOSTS');
    }

    if (!ip.v4 && !ip.v6) {
      return fail('No public IP available', { hostname, ip });
    }

    const split = splitHost(hostname, pb.domain);
    if (!split) {
      return fail(`Cannot determine Porkbun domain for "${hostname}". Set PORKBUN_DOMAIN.`, {
        hostname,
        hint: 'Use an FQDN in UDDNS_HOSTS or set PORKBUN_DOMAIN to the registered domain',
      });
    }

    const auth = { apikey: pb.apiKey!, secretapikey: pb.secretKey! };
    const results: UpdateResult[] = [];

    if (ip.v4) {
      results.push(await upsertRecord(auth, split, 'A', ip.v4));
    }
    if (ip.v6) {
      results.push(await upsertRecord(auth, split, 'AAAA', ip.v6));
    }

    return combineRecordResults(results, {
      domain: split.domain,
      subdomain: split.subdomain,
      hostname,
    });
  },
};

type HostSplit = {
  domain: string;
  subdomain: string;
};

/**
 * Map an FQDN or bare label onto Porkbun's domain + subdomain fields.
 * Without PORKBUN_DOMAIN the registered domain is assumed to be the
 * last two labels of the host.
 */
function splitHost(hostname: string, domain: string | null): HostSplit | null {
  const host = hostname.toLowerCase();

  if (domain) {
    const apex = domain.toLowerCase();
    if (host === apex) {
      return { domain: apex, subdomain: '' };
    }
    if (host.endsWith(`.${apex}`)) {
      return { domain: apex, subdomain: host.slice(0, -(apex.length + 1)) };
    }
    return { domain: apex, subdomain: host };
  }

  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return {
    domain: parts.slice(-2).join('.'),
    subdomain: parts.slice(0, -2).join('.'),
  };
}

type PorkbunAuth = {
  apikey: string;
  secretapikey: string;
};

async function upsertRecord(
  auth: PorkbunAuth,
  split: HostSplit,
  type: 'A' | 'AAAA',
  content: string,
): Promise<UpdateResult> {
  const { domain, subdomain } = split;
  const label = subdomain ? `${subdomain}.${domain}` : domain;
  const namePath = subdomain ? `/${subdomain}` : '';

  const retrieved = await porkbunJson(
    `${API}/dns/retrieveByNameType/${domain}/${type}${namePath}`,
    auth,
  );
  if (!retrieved.success) {
    return fail(formatPorkbunError(retrieved, `${type} record lookup for ${label}`), {
      domain,
      type,
      name: label,
      action: 'lookup',
      http: retrieved.meta,
    });
  }

  const record = retrieved.records?.[0] ?? null;

  if (record && record.content === content) {
    return skipped(`${type} ${label} unchanged (${content})`, {
      domain,
      recordId: String(record.id),
      type,
      name: label,
      content,
      action: 'unchanged',
    });
  }

  if (record) {
    const edited = await porkbunJson(`${API}/dns/editByNameType/${domain}/${type}${namePath}`, {
      ...auth,
      content,
    });

    if (edited.success) {
      return ok(`${type} ${label} -> ${content}`, {
        domain,
        recordId: String(record.id),
        type,
        name: label,
        previous: record.content,
        content,
        action: 'edit',
        http: edited.meta,
      });
    }

    return fail(formatPorkbunError(edited, `${type} record edit for ${label}`), {
      domain,
      recordId: String(record.id),
      type,
      name: label,
      content,
      action: 'edit',
      http: edited.meta,
    });
  }

  const created = await porkbunJson(`${API}/dns/create/${domain}`, {
    ...auth,
    name: subdomain,
    type,
    content,
  });

  if (created.success) {
    return ok(`Created ${type} ${label} -> ${content}`, {
      domain,
      type,
      name: label,
      content,
      action: 'create',
      http: created.meta,
    });
  }

  return fail(formatPorkbunError(created, `${type} record create for ${label}`), {
    domain,
    type,
    name: label,
    content,
    action: 'create',
    http: created.meta,
  });
}

type PorkbunResult = {
  success: boolean;
  message: string | null;
  records: PorkbunRecord[] | null;
  meta: RequestMeta;
};

async function porkbunJson(url: string, payload: Record<string, string>): Promise<PorkbunResult> {
  const { response, body, meta } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(body);
  } catch {
    throw new Error(
      `Porkbun returned non-JSON (${response.status} ${response.statusText}) from ${meta.url}: ${meta.bodyPreview}`,
    );
  }

  const parsed = porkbunEnvelopeSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error(`Porkbun returned invalid JSON from ${meta.url}: ${parsed.error.message}`);
  }

  return {
    success: response.ok && parsed.data.status.toUpperCase() === 'SUCCESS',
    message: parsed.data.message ?? null,
    records: parsed.data.records ?? null,
    meta,
  };
}

function formatPorkbunError(result: PorkbunResult, operation: string): string {
  if (result.message) {
    return `Porkbun ${operation} failed: ${result.message}`;
  }
  return `Porkbun ${operation} failed (HTTP ${result.meta.status} ${result.meta.statusText})`;
}
