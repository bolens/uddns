/**
 * Shared sensitive-key matching for log redaction and URL scrubbing.
 */

/** Matches object keys / query params that should never appear in cleartext logs. */
export const SENSITIVE_KEY_PATTERN =
  /pass(word)?|token|secret|authorization|api[-_]?key|credential|private|auth|key/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
