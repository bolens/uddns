/**
 * Shared DynDNS-compatible `/nic/update` client.
 */

import { fail, ok, skipped } from '../result.js';
import type { JsonObject } from '../schemas/json.js';
import type { PublicIP, UpdateResult } from '../schemas/provider.js';
import { requireIPv4 } from './guards.js';
import { basicAuthHeader, sanitizeUrl } from './http.js';
import { getQuery, ipDetails } from './query.js';

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

  const noIp = requireIPv4(ip, {
    hostname,
    updateUrl: sanitizeUrl(updateUrl),
  });
  if (noIp) {
    return noIp;
  }

  const params: Record<string, string> = {
    hostname,
    myip: ip.v4!,
  };
  if (ip.v6) {
    params[ipv6Param] = ip.v6;
  }

  const { response, body, meta } = await getQuery(updateUrl, params, {
    headers: {
      Authorization: basicAuthHeader(username, password),
    },
  });

  return interpretNicUpdateBody(body, response.status, ipDetails(ip, meta, { hostname }));
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
  const providerOutage = code === '911' || code === 'dnserr';
  const enriched: JsonObject = {
    ...details,
    httpStatus: providerOutage && status < 500 ? 503 : status,
    response: text,
    ...(hint ? { hint } : {}),
    ...(providerOutage ? { retryable: true } : {}),
  };

  if (/^nochg/i.test(text)) {
    return skipped(message, enriched);
  }

  if (/^good/i.test(text) && status >= 200 && status < 300) {
    return ok(message, enriched);
  }

  return fail(hint ? `${message} (${hint})` : message, enriched);
}
