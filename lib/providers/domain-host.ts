/** Lowercase and strip a trailing DNS root dot. */
export function normalizeDnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
}

/**
 * Derive a two-label registered domain only for short FQDNs (2–3 labels).
 * Longer names (e.g. home.example.co.uk) need an explicit domain/zone setting.
 */
export function deriveTwoLabelApex(hostname: string): { domain: string; name: string } | null {
  const host = normalizeDnsName(hostname);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  return {
    domain: parts.slice(-2).join('.'),
    name: parts.length === 2 ? '@' : (parts[0] ?? '@'),
  };
}

export function splitDomainHost(
  hostname: string,
  domain: string | null,
): { domain: string; name: string } | null {
  const host = normalizeDnsName(hostname);
  if (domain) {
    const apex = normalizeDnsName(domain);
    if (host === apex) {
      return { domain: apex, name: '@' };
    }
    if (host.endsWith(`.${apex}`)) {
      return { domain: apex, name: host.slice(0, -(apex.length + 1)) };
    }
    return null;
  }
  return deriveTwoLabelApex(host);
}
