/**
 * Shared sensitive-key matching for log redaction and URL scrubbing.
 */

/** Matches one complete sensitive key segment, never an arbitrary substring. */
export const SENSITIVE_KEY_PATTERN =
  /^(?:pass(?:word)?|token|secret(?:apikey)?|authorization|api[-_]?key|apikey|credential|private|auth|key|webhook|user(?:name)?|apiuser|client[_-]?id)$/i;

export function isSensitiveKey(key: string): boolean {
  // Notify destinations and DynDNS update URLs often embed tokens/userinfo.
  if (/notify.*url/i.test(key) || /^update[_-]?url$/i.test(key)) {
    return true;
  }

  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }

  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);

  return segments.some((segment) => SENSITIVE_KEY_PATTERN.test(segment));
}
