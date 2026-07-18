/**
 * Shared outbound HTTPS URL policy (scheme, userinfo, and host safety).
 */

import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

export type HttpsUrlPolicy = {
  /**
   * When true, allow RFC1918 private hosts (e.g. self-hosted ntfy on LAN).
   * Loopback, link-local, cloud-metadata, and IP-embedding of those are still blocked.
   */
  allowPrivateHosts?: boolean;
};

export type HostLookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const defaultHostLookup: HostLookupFn = (hostname, options) => dns.lookup(hostname, options);

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
  if (isBlockedOutboundHost(url.hostname, policy)) {
    throw new Error(
      policy.allowPrivateHosts
        ? `${label} must not target loopback, link-local, or cloud-metadata hosts`
        : `${label} must not target loopback, private, link-local, or cloud-metadata hosts`,
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

/**
 * Resolve hostname and reject if any A/AAAA address is blocked under `policy`.
 * No-op for IP literals (already checked by {@link assertHttpsUrl} / {@link isBlockedOutboundHost}).
 */
export async function assertResolvedHttpsHostSafe(
  url: URL,
  label: string,
  policy: HttpsUrlPolicy = {},
  lookup: HostLookupFn = defaultHostLookup,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedOutboundHost(host, policy)) {
      throw new Error(`${label} targets a blocked address`);
    }
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} host "${host}" could not be resolved (${reason})`);
  }
  if (addresses.length === 0) {
    throw new Error(`${label} host "${host}" resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isBlockedOutboundHost(address, policy)) {
      throw new Error(`${label} resolves to blocked address ${address}`);
    }
  }
}

export function isBlockedOutboundHost(hostname: string, policy: HttpsUrlPolicy = {}): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isAlwaysBlockedHostname(host)) {
    return true;
  }

  const version = isIP(host);
  if (version === 4) {
    if (isAlwaysBlockedIpv4(host)) {
      return true;
    }
    if (!policy.allowPrivateHosts && isPrivateOrCgnatIpv4(host)) {
      return true;
    }
    return false;
  }
  if (version === 6) {
    if (isAlwaysBlockedIpv6(host)) {
      return true;
    }
    if (!policy.allowPrivateHosts && isPrivateIpv6(host)) {
      return true;
    }
    return false;
  }

  // nip.io / sslip.io style embeds (only on non-literal hostnames)
  const embedded = extractEmbeddedIpv4FromHostname(host);
  if (embedded) {
    if (isAlwaysBlockedIpv4(embedded)) {
      return true;
    }
    return !policy.allowPrivateHosts;
  }

  return false;
}

function isAlwaysBlockedHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  );
}

/** Detect a.b.c.d embedded as DNS labels (nip.io, sslip.io, xip.io, …). */
function extractEmbeddedIpv4FromHostname(host: string): string | null {
  const match = host.match(/(?:^|\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.|$)/);
  if (!match) {
    return null;
  }
  const candidate = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  if (!isIpv4Literal(candidate)) {
    return null;
  }
  return candidate;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  return (
    parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function isAlwaysBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}

function isPrivateOrCgnatIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isAlwaysBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;

  const mappedIpv4 = extractIpv4MappedAddress(normalized);
  if (mappedIpv4) {
    return isAlwaysBlockedIpv4(mappedIpv4);
  }

  if (normalized.startsWith('fe80:')) return true; // link-local
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  const mappedIpv4 = extractIpv4MappedAddress(normalized);
  if (mappedIpv4) {
    return isPrivateOrCgnatIpv4(mappedIpv4);
  }
  // ULA fc00::/7
  return /^f[cd][0-9a-f]{0,2}:/i.test(normalized);
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
