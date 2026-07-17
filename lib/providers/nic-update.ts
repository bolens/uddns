/**
 * Shared DynDNS-compatible `/nic/update` client.
 */

import { fail, ok, skipped } from '../result.js';
import type { JsonObject } from '../schemas/json.js';
import type { PublicIP, UpdateResult } from '../schemas/provider.js';
import { basicAuthHeader, request, sanitizeUrl } from './http.js';

const NIC_HINTS: Record<string, string> = {
  badauth: 'Authentication failed — check UDDNS_USER / UDDNS_PASS',
  notfqdn: 'Hostname is not a fully-qualified domain name',
  nohost: 'Hostname not found under this account',
  numhost: 'Too many hosts specified',
  abuse: 'Update blocked due to abuse / too frequent updates',
  badagent: 'User-Agent blocked by provider',
  '!donator': 'Feature requires a paid plan',
  '911': 'Provider is having a server error; retry later',
  dnserr: 'DNS error on provider side',
};

export type NicUpdateOptions = {
  updateUrl: string;
  username: string;
  password: string;
  hostname: string;
  ip: PublicIP;
  ipv6Param?: string;
};

export async function updateNicDns(options: NicUpdateOptions): Promise<UpdateResult> {
  const { updateUrl, username, password, hostname, ip, ipv6Param = 'myipv6' } = options;

  if (!ip.v4) {
    return fail('No public IPv4 available', {
      hostname,
      updateUrl: sanitizeUrl(updateUrl),
      ip,
    });
  }

  const url = new URL(updateUrl);
  url.searchParams.set('hostname', hostname);
  url.searchParams.set('myip', ip.v4);
  if (ip.v6) {
    url.searchParams.set(ipv6Param, ip.v6);
  }

  const { response, body, meta } = await request(url, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(username, password),
    },
  });

  return interpretNicUpdateBody(body, response.status, {
    hostname,
    ipv4: ip.v4,
    ipv6: ip.v6,
    ...meta,
  });
}

/**
 * Parse classic DynDNS response bodies (`good`, `nochg`, `badauth`, ...).
 */
export function interpretNicUpdateBody(
  body: string,
  status: number,
  details: JsonObject = {},
): UpdateResult {
  const text = body.trim();
  const code = text.split(/\s+/)[0]?.toLowerCase() ?? '';
  const hint = NIC_HINTS[code];
  const message = text || `HTTP ${status}`;
  const enriched: JsonObject = {
    ...details,
    httpStatus: status,
    response: text,
    ...(hint ? { hint } : {}),
  };

  if (/^nochg/i.test(text)) {
    return skipped(message, enriched);
  }

  if (/^good/i.test(text) && status >= 200 && status < 300) {
    return ok(message, enriched);
  }

  return fail(hint ? `${message} (${hint})` : message, enriched);
}
