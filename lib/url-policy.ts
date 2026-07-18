/**
 * Shared outbound HTTPS URL policy (scheme, userinfo, and host safety).
 */

import { isIP } from 'node:net';

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

/**
 * Assert the URL host is in an allowlist (exact hostname match, case-insensitive).
 * Call after {@link assertHttpsUrl}.
 */
export function assertHttpsUrlHostAllowed(
  url: URL,
  label: string,
  allowedHosts: readonly string[],
): void {
  const host = url.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((entry) => entry.toLowerCase()));
  if (!allowed.has(host)) {
    throw new Error(
      `${label} host "${host}" is not allowed (allowed: ${[...allowed].sort().join(', ')})`,
    );
  }
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

  const version = isIP(host);
  if (version === 4) {
    return isBlockedIpv4(host);
  }
  if (version === 6) {
    return isBlockedIpv6(host);
  }
  return false;
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

/**
 * Block loopback / ULA / link-local IPv6, and IPv4-mapped forms that Node may
 * normalize to hex (`::ffff:a9fe:a9fe` for 169.254.169.254).
 */
function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;

  const mappedIpv4 = extractIpv4MappedAddress(normalized);
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }

  // Expand leading compressed forms enough for prefix checks.
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{0,2}:/i.test(normalized)) return true; // ULA fc00::/7
  return false;
}

/** Extract embedded IPv4 from ::ffff:dotted or ::ffff:hhhh:hhhh (Node URL form). */
function extractIpv4MappedAddress(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    return dotted[1];
  }
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex?.[1] || !hex[2]) {
    return null;
  }
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    return null;
  }
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
