/**
 * Shared sensitive-key matching for log redaction and URL scrubbing.
 */

/** Matches one complete sensitive key segment, never an arbitrary substring. */
export const SENSITIVE_KEY_PATTERN =
  /^(?:pass(?:word)?|token|secret|authorization|api[-_]?key|apikey|credential|private|auth|key)$/i;

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }

  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);

  return segments.some((segment) => SENSITIVE_KEY_PATTERN.test(segment));
}
