import type { JsonObject } from './schemas/json.js';
import type { UpdateResult } from './schemas/provider.js';

export function ok(message: string, details?: JsonObject): UpdateResult {
  return details ? { ok: true, message, details } : { ok: true, message };
}

export function skipped(message: string, details?: JsonObject): UpdateResult {
  return details
    ? { ok: true, skipped: true, message, details }
    : { ok: true, skipped: true, message };
}

export function fail(message: string, details?: JsonObject): UpdateResult {
  return details ? { ok: false, message, details } : { ok: false, message };
}

export function formatResultSummary(result: UpdateResult): string {
  const status = result.ok ? (result.skipped ? 'skipped' : 'ok') : 'error';
  return `[${status}] ${result.message}`;
}
