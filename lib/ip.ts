/**
 * Public IP discovery via HTTPS echo services, with DNS (OpenDNS / Google)
 * fallbacks.
 *
 * HTTPS is tried first because TLS authenticates the answer's origin. Plain
 * port-53 DNS responses can be forged by an on-path attacker, which would let
 * them steer DNS records at an attacker-controlled address; it is kept only
 * as a fallback for networks where the HTTPS echo services are unreachable.
 */

import dns from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

import { DEFAULT_IP_TIMEOUT_MS } from './defaults.js';
import { errorMessage } from './errors.js';
import { formatError, type ErrorInfo } from './log.js';
import { sanitizeUrl } from './providers/http.js';
import type { PublicIP } from './schemas/provider.js';

const OPENDNS_V4 = ['208.67.222.222', '208.67.220.220'];
const OPENDNS_V6 = ['2620:119:35::35', '2620:119:53::53'];
const GOOGLE_DNS_V4 = ['8.8.8.8', '8.8.4.4'];
const GOOGLE_DNS_V6 = ['2001:4860:4860::8888', '2001:4860:4860::8844'];

const DEFAULT_HTTPS_ENDPOINTS = {
  v4: ['https://ipv4.icanhazip.com', 'https://api.ipify.org', 'https://ifconfig.co/ip'],
  v6: ['https://ipv6.icanhazip.com', 'https://api64.ipify.org', 'https://ifconfig.co/ip'],
} as const;

export type PublicIPDiscovery = {
  ip: PublicIP;
  errors: { v4: ErrorInfo | null; v6: ErrorInfo | null };
};

export type DnsResolver = {
  setServers: (servers: string[]) => void;
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
  resolveTxt: (hostname: string) => Promise<string[][]>;
};

export type DiscoverDeps = {
  fetch: typeof globalThis.fetch;
  createResolver: () => DnsResolver;
  timeoutMs?: number;
  httpsV4?: readonly string[];
  httpsV6?: readonly string[];
  dnsFallback?: boolean;
};

const defaultDeps: DiscoverDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  createResolver: () => {
    const resolver = new dns.Resolver();
    return {
      setServers: (servers) => {
        resolver.setServers(servers);
      },
      resolve4: (hostname) => resolver.resolve4(hostname),
      resolve6: (hostname) => resolver.resolve6(hostname),
      resolveTxt: (hostname) => resolver.resolveTxt(hostname),
    };
  },
};

type AddressFamily = 'v4' | 'v6';

function timeoutError(): Error {
  return new Error('Public IP discovery timed out');
}

function isValidForFamily(value: string, family: AddressFamily): boolean {
  return family === 'v4' ? isIPv4(value) : isIPv6(value);
}

function parseCandidate(raw: string, family: AddressFamily): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  return isValidForFamily(value, family) ? value : null;
}

async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw timeoutError();
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(timeoutError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function lookupViaOpenDns(
  family: AddressFamily,
  deps: DiscoverDeps,
  signal: AbortSignal,
): Promise<string> {
  const resolver = deps.createResolver();
  resolver.setServers(family === 'v4' ? OPENDNS_V4 : OPENDNS_V6);
  const records =
    family === 'v4'
      ? await withTimeout(resolver.resolve4('myip.opendns.com'), signal)
      : await withTimeout(resolver.resolve6('myip.opendns.com'), signal);
  const candidate = parseCandidate(records[0] ?? '', family);
  if (!candidate) {
    throw new Error(`OpenDNS returned invalid ${family} address`);
  }
  return candidate;
}

async function lookupViaGoogleTxt(
  family: AddressFamily,
  deps: DiscoverDeps,
  signal: AbortSignal,
): Promise<string> {
  const resolver = deps.createResolver();
  resolver.setServers(family === 'v4' ? GOOGLE_DNS_V4 : GOOGLE_DNS_V6);
  const records = await withTimeout(resolver.resolveTxt('o-o.myaddr.l.google.com'), signal);
  const flat = records.map((parts) => parts.join('')).join('');
  const candidate = parseCandidate(flat, family);
  if (!candidate) {
    throw new Error(`Google DNS TXT returned invalid ${family} address`);
  }
  return candidate;
}

async function lookupViaHttps(
  family: AddressFamily,
  deps: DiscoverDeps,
  signal: AbortSignal,
): Promise<string> {
  const errors: string[] = [];
  const endpoints =
    family === 'v4'
      ? (deps.httpsV4 ?? DEFAULT_HTTPS_ENDPOINTS.v4)
      : (deps.httpsV6 ?? DEFAULT_HTTPS_ENDPOINTS.v6);

  for (const endpoint of endpoints) {
    const endpointLabel = sanitizeUrl(endpoint);
    try {
      // Follow redirects, but reject cleartext final URLs so a compromised echo
      // host cannot downgrade TLS and steer DNS to an attacker IP.
      const response = await deps.fetch(endpoint, { signal, redirect: 'follow' });
      if (!response.ok) {
        errors.push(`${endpointLabel} HTTP ${response.status}`);
        continue;
      }
      const finalUrl = response.url?.trim();
      if (!finalUrl) {
        // Undici always sets response.url; treat a missing final URL as unsafe when
        // redirects were followed so we cannot confirm the answer stayed on HTTPS.
        errors.push(`${endpointLabel} missing final URL after redirect follow`);
        continue;
      }
      let final: URL;
      try {
        final = new URL(finalUrl);
      } catch {
        errors.push(`${endpointLabel} redirected to invalid URL`);
        continue;
      }
      if (final.protocol !== 'https:') {
        errors.push(`${endpointLabel} redirected off HTTPS (${sanitizeUrl(finalUrl)})`);
        continue;
      }
      let requested: URL;
      try {
        requested = new URL(endpoint);
      } catch {
        errors.push(`${endpointLabel} is not a valid URL`);
        continue;
      }
      // Cross-host HTTPS redirects can move the trusted echo answer onto an
      // attacker-controlled host; pin the final host to the configured endpoint.
      if (final.hostname.toLowerCase() !== requested.hostname.toLowerCase()) {
        errors.push(`${endpointLabel} redirected to different host (${sanitizeUrl(finalUrl)})`);
        continue;
      }
      const text = await response.text();
      const candidate = parseCandidate(text, family);
      if (candidate) {
        return candidate;
      }
      errors.push(`${endpointLabel} invalid body`);
    } catch (error) {
      if (signal.aborted) {
        throw timeoutError();
      }
      errors.push(`${endpointLabel}: ${errorMessage(error)}`);
    }
  }

  throw new Error(`HTTPS ${family} lookup failed (${errors.join('; ')})`);
}

async function discoverFamily(
  family: AddressFamily,
  deps: DiscoverDeps,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await lookupViaHttps(family, deps, signal);
  } catch {
    if (signal.aborted) {
      throw timeoutError();
    }
    // fall through
  }

  if (deps.dnsFallback === false) {
    throw new Error(`HTTPS ${family} lookup failed and DNS fallback is disabled`);
  }

  try {
    return await lookupViaOpenDns(family, deps, signal);
  } catch {
    if (signal.aborted) {
      throw timeoutError();
    }
    // fall through
  }

  return lookupViaGoogleTxt(family, deps, signal);
}

/**
 * Resolve the machine's current public IPv4/IPv6 addresses.
 * Missing families are returned as `null` rather than throwing.
 */
export async function discoverPublicIP(
  deps: DiscoverDeps = defaultDeps,
): Promise<PublicIPDiscovery> {
  const ip: PublicIP = { v4: null, v6: null };
  const errors: PublicIPDiscovery['errors'] = { v4: null, v6: null };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? DEFAULT_IP_TIMEOUT_MS);

  try {
    const [v4Result, v6Result] = await Promise.allSettled([
      discoverFamily('v4', deps, controller.signal),
      discoverFamily('v6', deps, controller.signal),
    ]);

    if (v4Result.status === 'fulfilled') {
      ip.v4 = v4Result.value;
    } else {
      errors.v4 = formatError(v4Result.reason);
    }

    if (v6Result.status === 'fulfilled') {
      ip.v6 = v6Result.value;
    } else {
      errors.v6 = formatError(v6Result.reason);
    }
  } finally {
    clearTimeout(timer);
  }

  return { ip, errors };
}

export async function getPublicIP(deps?: DiscoverDeps): Promise<PublicIP> {
  const { ip } = await discoverPublicIP(deps);
  return ip;
}

export function ipChanged(next: PublicIP, previous: PublicIP): boolean {
  // Null families in `next` mean "omit from this update" (e.g. IP_MISSING=clear),
  // not "family changed to empty" — only compare families that are present.
  return (
    (next.v4 !== null && next.v4 !== previous.v4) || (next.v6 !== null && next.v6 !== previous.v6)
  );
}

/** Keep previously known families when the next snapshot omits them (null). */
export function mergePresentFamilies(previous: PublicIP, next: PublicIP): PublicIP {
  return {
    v4: next.v4 ?? previous.v4,
    v6: next.v6 ?? previous.v6,
  };
}

export function formatPublicIP(ip: PublicIP): string {
  const parts = [ip.v4 && `IPv4 ${ip.v4}`, ip.v6 && `IPv6 ${ip.v6}`].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '(none)';
}
