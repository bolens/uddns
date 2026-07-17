/**
 * Shared GET query-string request scaffolding for simple DDNS providers.
 */

import type { JsonObject } from '../schemas/json.js';
import type { PublicIP } from '../schemas/provider.js';
import {
  request,
  type RequestInitWithTimeout,
  type RequestMeta,
  type RequestResult,
} from './http.js';

export type QueryRequestResult = RequestResult & {
  text: string;
};

/**
 * Build a GET request to a query-string API and return the trimmed body.
 */
export async function getQuery(
  base: string,
  params: Record<string, string>,
  init: RequestInitWithTimeout = {},
): Promise<QueryRequestResult> {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const result = await request(url, { ...init, method: init.method ?? 'GET' });
  return {
    ...result,
    text: result.body.trim(),
  };
}

/** Assemble the common IP + request-meta detail object used by providers. */
export function ipDetails(ip: PublicIP, meta: RequestMeta, extra: JsonObject = {}): JsonObject {
  return {
    ...extra,
    ipv4: ip.v4,
    ipv6: ip.v6,
    ...meta,
  };
}
