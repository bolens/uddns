/** Lowercase and strip a trailing DNS root dot. */
export function normalizeDnsName(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
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
  const parts = host.split('.');
  return parts.length < 2
    ? null
    : { domain: parts.slice(-2).join('.'), name: parts.slice(0, -2).join('.') || '@' };
}
