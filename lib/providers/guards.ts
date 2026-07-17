/**
 * Shared provider update guards (required credentials / public IP).
 */

import { fail, ok, skipped } from '../result.js';
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

/**
 * Merge per-record-type results (A/AAAA) into one provider result:
 * any failure fails, all-skipped skips, otherwise ok.
 */
export function combineRecordResults(
  results: UpdateResult[],
  details: JsonObject = {},
): UpdateResult {
  const message = results.map((result) => result.message).join('; ');
  const merged: JsonObject = {
    ...details,
    results: results.map((result) => ({
      ok: result.ok,
      skipped: result.skipped ?? false,
      message: result.message,
      details: result.details ?? null,
    })),
  };

  if (results.some((result) => !result.ok)) {
    return fail(message, merged);
  }
  if (results.every((result) => result.skipped)) {
    return skipped(message, merged);
  }
  return ok(message, merged);
}
