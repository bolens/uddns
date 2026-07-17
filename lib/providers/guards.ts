/**
 * Shared provider update guards (required credentials / public IP).
 */

import { fail } from '../result.js';
import type { JsonObject } from '../schemas/json.js';
import type { PublicIP, UpdateResult } from '../schemas/provider.js';

/**
 * Return a fail() result when any required value is falsy; otherwise null.
 * Callers supply the exact message and detail object so provider copy stays stable.
 */
export function requireFields(
  message: string,
  required: unknown[],
  details: JsonObject = {},
): UpdateResult | null {
  if (required.every(Boolean)) {
    return null;
  }
  return fail(message, details);
}

/** Standardized "no public IPv4" guard used by IPv4-only providers. */
export function requireIPv4(ip: PublicIP, details: JsonObject = {}): UpdateResult | null {
  if (ip.v4) {
    return null;
  }
  return fail('No public IPv4 available', { ...details, ip });
}
