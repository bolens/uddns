export function splitDomainHost(
  hostname: string,
  domain: string | null,
): { domain: string; name: string } | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (domain) {
    const apex = domain.toLowerCase().replace(/\.$/, '');
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
