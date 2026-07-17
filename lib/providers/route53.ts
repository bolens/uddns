/**
 * AWS Route53 DNS provider.
 *
 * Talks to the Route53 REST API directly (XML payloads) with a minimal
 * SigV4 signer built on node:crypto — no AWS SDK dependency.
 */

import { createHash, createHmac } from 'node:crypto';

import { fail, ok, skipped } from '../result.js';
import type { Provider, UpdateResult } from '../schemas/provider.js';
import { combineRecordResults, requireFields } from './guards.js';
import { request, type RequestMeta } from './http.js';

const API_HOST = 'route53.amazonaws.com';
const API_VERSION = '2013-04-01';
const SERVICE = 'route53';

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

export const route53Provider: Provider = {
  id: 'route53',
  label: 'AWS Route53',
  async update(config, ip) {
    const r53 = config.route53;
    const recordName = config.hostname;

    const missing = requireFields(
      'route53 requires ROUTE53_ACCESS_KEY_ID, ROUTE53_SECRET_ACCESS_KEY, and ROUTE53_HOSTED_ZONE_ID',
      [r53.accessKeyId, r53.secretAccessKey, r53.hostedZoneId],
      {
        hasAccessKeyId: Boolean(r53.accessKeyId),
        hasSecretAccessKey: Boolean(r53.secretAccessKey),
        hasHostedZoneId: Boolean(r53.hostedZoneId),
      },
    );
    if (missing) {
      return missing;
    }

    if (!recordName) {
      return fail('route53 requires UDDNS_HOST or UDDNS_HOSTS');
    }

    if (!ip.v4 && !ip.v6) {
      return fail('No public IP available', { recordName, ip });
    }

    const zoneId = r53.hostedZoneId!.replace(/^\/?hostedzone\//, '');
    const credentials: AwsCredentials = {
      accessKeyId: r53.accessKeyId!,
      secretAccessKey: r53.secretAccessKey!,
      region: r53.region,
    };

    const results: UpdateResult[] = [];

    if (ip.v4) {
      results.push(
        await upsertRecordSet({
          credentials,
          zoneId,
          name: recordName,
          type: 'A',
          content: ip.v4,
          ttl: r53.ttl,
          createIfMissing: r53.createIfMissing,
        }),
      );
    }

    if (ip.v6) {
      results.push(
        await upsertRecordSet({
          credentials,
          zoneId,
          name: recordName,
          type: 'AAAA',
          content: ip.v6,
          ttl: r53.ttl,
          createIfMissing: r53.createIfMissing,
        }),
      );
    }

    return combineRecordResults(results, {
      zoneId,
      recordName,
      region: r53.region,
      ttl: r53.ttl,
    });
  },
};

type UpsertOptions = {
  credentials: AwsCredentials;
  zoneId: string;
  name: string;
  type: 'A' | 'AAAA';
  content: string;
  ttl: number;
  createIfMissing: boolean;
};

async function upsertRecordSet(options: UpsertOptions): Promise<UpdateResult> {
  const { credentials, zoneId, name, type, content, ttl, createIfMissing } = options;
  const fqdn = name.endsWith('.') ? name : `${name}.`;

  const existing = await findRecordSet(credentials, zoneId, fqdn, type);

  if (
    existing &&
    existing.values.length === 1 &&
    existing.values[0] === content &&
    (existing.ttl === null || existing.ttl === ttl)
  ) {
    return skipped(`${type} ${name} unchanged (${content})`, {
      zoneId,
      type,
      name,
      content,
      ttl,
      action: 'unchanged',
    });
  }

  if (!existing && !createIfMissing) {
    return fail(`${type} record for ${name} not found`, {
      zoneId,
      type,
      name,
      createIfMissing,
      hint: 'Create the record in Route53 or set ROUTE53_CREATE_IF_MISSING=true',
    });
  }

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/${API_VERSION}/">` +
    '<ChangeBatch><Changes><Change><Action>UPSERT</Action><ResourceRecordSet>' +
    `<Name>${xmlEscape(fqdn)}</Name><Type>${type}</Type><TTL>${ttl}</TTL>` +
    `<ResourceRecords><ResourceRecord><Value>${xmlEscape(content)}</Value></ResourceRecord></ResourceRecords>` +
    '</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>';

  const changed = await route53Request(
    credentials,
    'POST',
    new URL(`https://${API_HOST}/${API_VERSION}/hostedzone/${zoneId}/rrset/`),
    body,
  );

  const action = existing ? 'upsert' : 'create';

  if (changed.response.ok) {
    const message = existing
      ? `${type} ${name} -> ${content}`
      : `Created ${type} ${name} -> ${content}`;
    return ok(message, {
      zoneId,
      type,
      name,
      ...(existing ? { previous: existing.values.join(',') } : {}),
      content,
      ttl,
      action,
      changeId: xmlText(changed.body, 'Id'),
      http: changed.meta,
    });
  }

  return fail(formatRoute53Error(changed.body, changed.meta), {
    zoneId,
    type,
    name,
    content,
    action,
    http: changed.meta,
  });
}

type RecordSet = {
  name: string;
  type: string;
  ttl: number | null;
  values: string[];
};

async function findRecordSet(
  credentials: AwsCredentials,
  zoneId: string,
  fqdn: string,
  type: 'A' | 'AAAA',
): Promise<RecordSet | null> {
  const url = new URL(`https://${API_HOST}/${API_VERSION}/hostedzone/${zoneId}/rrset`);
  url.searchParams.set('name', fqdn);
  url.searchParams.set('type', type);
  url.searchParams.set('maxitems', '1');

  const listed = await route53Request(credentials, 'GET', url);
  if (!listed.response.ok) {
    const error = new Error(
      `Route53 ${type} record lookup for ${fqdn} failed: ${formatRoute53Error(listed.body, listed.meta)}`,
    );
    Object.assign(error, {
      status: listed.meta.status,
      details: { http: listed.meta },
      retryAfterMs: listed.meta.retryAfterMs,
    });
    throw error;
  }

  const recordSet = parseFirstRecordSet(listed.body);
  if (!recordSet) {
    return null;
  }

  // The list API starts at name/type and returns the *next* record set when
  // there is no exact match, so verify before treating it as existing.
  if (normalizeDnsName(recordSet.name) !== normalizeDnsName(fqdn) || recordSet.type !== type) {
    return null;
  }

  return recordSet;
}

function parseFirstRecordSet(xml: string): RecordSet | null {
  const block = xml.match(/<ResourceRecordSet>([\s\S]*?)<\/ResourceRecordSet>/)?.[1];
  if (!block) {
    return null;
  }

  const name = xmlText(block, 'Name');
  const type = xmlText(block, 'Type');
  if (!name || !type) {
    return null;
  }

  const ttlRaw = xmlText(block, 'TTL');
  const values = [...block.matchAll(/<Value>([^<]*)<\/Value>/g)].map((match) =>
    xmlUnescape(match[1] ?? ''),
  );

  return {
    name,
    type,
    ttl: ttlRaw === null ? null : Number(ttlRaw),
    values,
  };
}

function normalizeDnsName(value: string): string {
  const lower = value.toLowerCase();
  return lower.endsWith('.') ? lower : `${lower}.`;
}

function formatRoute53Error(body: string, meta: RequestMeta): string {
  const code = xmlText(body, 'Code');
  const message = xmlText(body, 'Message');
  if (message) {
    return code ? `${message} [${code}]` : message;
  }
  return `Route53 API request failed (HTTP ${meta.status} ${meta.statusText})`;
}

async function route53Request(
  credentials: AwsCredentials,
  method: 'GET' | 'POST',
  url: URL,
  body = '',
): Promise<{ response: Response; body: string; meta: RequestMeta }> {
  const amzDate = toAmzDate(new Date());
  const authorization = signV4({ credentials, method, url, amzDate, payload: body });

  const headers = new Headers({
    'x-amz-date': amzDate,
    Authorization: authorization,
  });
  if (method === 'POST') {
    headers.set('Content-Type', 'application/xml');
  }

  return request(url, {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
  });
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

type SignOptions = {
  credentials: AwsCredentials;
  method: string;
  url: URL;
  amzDate: string;
  payload: string;
};

/** Minimal AWS Signature Version 4 (signed headers: host + x-amz-date). */
function signV4(options: SignOptions): string {
  const { credentials, method, url, amzDate, payload } = options;
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = 'host;x-amz-date';

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url),
    `host:${url.host}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, credentials.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function canonicalQuery(url: URL): string {
  // Duplicate query keys never occur here, so sorting by key alone is safe.
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xmlEscape(value: string): string {
  /* v8 ignore next: the regex only matches keys present in XML_ESCAPES */
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1] === undefined ? null : xmlUnescape(match[1]);
}
