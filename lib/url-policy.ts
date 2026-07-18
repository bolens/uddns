/**
 * Shared outbound HTTPS URL policy (scheme, userinfo, and host safety).
 */

export type HttpsUrlPolicy = {
  /** When true, allow RFC1918 / loopback / link-local (e.g. self-hosted ntfy). */
  allowPrivateHosts?: boolean;
};

/**
 * Parse and validate an https URL. Rejects cleartext, embedded userinfo, and
 * (by default) loopback / private / link-local / cloud-metadata hosts.
 */
export function assertHttpsUrl(value: string, label: string, policy: HttpsUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid https:// URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `${label} must be a valid https:// URL (credentials would travel in cleartext over http)`,
    );
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials in the URL`);
  }
  if (!policy.allowPrivateHosts && isBlockedOutboundHost(url.hostname)) {
    throw new Error(
      `${label} must not target loopback, private, link-local, or cloud-metadata hosts`,
    );
  }
  return url;
}

export function isBlockedOutboundHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  if (isIpv4Literal(host)) {
    return isBlockedIpv4(host);
  }
  if (host.includes(':')) {
    return isBlockedIpv6(host);
  }
  return false;
}

function isIpv4Literal(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80:')) return true; // link-local
  // IPv4-mapped ::ffff:x.x.x.x
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) {
    return isBlockedIpv4(mapped[1]);
  }
  return false;
}
