/** Lowercase and strip a trailing DNS root dot. */
export function normalizeDnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
}

/**
 * Common multi-part public suffixes where the last two labels are NOT the
 * registrable domain (e.g. example.co.uk → not "co.uk").
 */
const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'ltd.uk',
  'plc.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.br',
  'net.br',
  'org.br',
  'co.za',
  'org.za',
  'com.mx',
  'org.mx',
  'com.sg',
  'com.hk',
]);

/**
 * True when an explicit provider domain/zone is required (bare labels,
 * multi-label names, or 3-label names under a multi-part public suffix).
 */
export function requiresExplicitDomain(hostname: string): boolean {
  const host = normalizeDnsName(hostname);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) {
    return true;
  }
  if (parts.length > 3) {
    return true;
  }
  if (parts.length === 3) {
    const suffix = parts.slice(-2).join('.');
    return MULTI_PART_PUBLIC_SUFFIXES.has(suffix);
  }
  return false;
}

/**
 * Derive a two-label registered domain only for short FQDNs (2–3 labels).
 * Longer names and multi-part public suffixes need an explicit domain/zone setting.
 */
export function deriveTwoLabelApex(hostname: string): { domain: string; name: string } | null {
  const host = normalizeDnsName(hostname);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  if (parts.length === 3) {
    const suffix = parts.slice(-2).join('.');
    if (MULTI_PART_PUBLIC_SUFFIXES.has(suffix)) {
      return null;
    }
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
    // Bare labels are treated as subdomains under the configured apex.
    if (!host.includes('.')) {
      return { domain: apex, name: host || '@' };
    }
    return null;
  }
  return deriveTwoLabelApex(host);
}
