/**
 * HTTPS fetch that resolves DNS once, rejects blocked addresses, then connects
 * only to the verified set (custom Agent lookup) to close DNS-rebinding gaps.
 */

import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';

import { resolveSafeAddresses, type HostLookupFn, type HttpsUrlPolicy } from './url-policy.js';

export type PinnedHttpsInit = {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string | Buffer | null;
  signal?: AbortSignal;
  /** Default `error` (notify/providers). IP discovery uses `follow` with same-host only. */
  redirect?: 'error' | 'follow';
  policy?: HttpsUrlPolicy;
  lookupHost?: HostLookupFn;
  /** Max hops when redirect is `follow`. */
  maxRedirects?: number;
};

/**
 * Perform an HTTPS request with DNS pin-on-connect. Does not use global fetch,
 * so the OS cannot re-resolve to a different address between check and dial.
 */
export async function pinnedHttpsFetch(
  input: string | URL,
  init: PinnedHttpsInit = {},
): Promise<Response> {
  const redirectMode = init.redirect ?? 'error';
  const maxRedirects = init.maxRedirects ?? 5;
  let current = typeof input === 'string' ? new URL(input) : new URL(input.href);
  const method = (init.method ?? 'GET').toUpperCase();
  let body = init.body ?? null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== 'https:') {
      throw new Error(`Refusing non-HTTPS URL after pin (${current.protocol})`);
    }
    const label = current.href;
    const addresses = preferConnectAddresses(
      await resolveSafeAddresses(current, label, init.policy ?? {}, init.lookupHost),
    );
    const family = addresses[0]!.family === 6 ? 6 : 4;
    const result = await httpsRequestPinned(current, addresses, {
      method,
      body,
      family,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });

    if (result.statusCode >= 300 && result.statusCode < 400) {
      const locationHeader = result.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) {
        return toResponse(result, current.href);
      }
      if (redirectMode === 'error') {
        throw new Error(`Unexpected redirect from ${label} to ${location}`);
      }
      const next = new URL(location, current);
      if (next.protocol !== 'https:') {
        throw new Error(`Redirect left HTTPS (${next.protocol})`);
      }
      if (next.hostname.toLowerCase() !== current.hostname.toLowerCase()) {
        throw new Error(`Redirect changed host (${current.hostname} -> ${next.hostname})`);
      }
      current = next;
      // IP echo uses GET; drop body on redirect for safety.
      body = null;
      continue;
    }

    return toResponse(result, current.href);
  }

  throw new Error(`Too many redirects (max ${maxRedirects})`);
}

type PinnedRequestResult = {
  statusCode: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
};

/** Prefer IPv4 when present so IPv6-unreachable hosts do not fail the whole dial. */
function preferConnectAddresses(addresses: LookupAddress[]): LookupAddress[] {
  const v4 = addresses.filter((entry) => entry.family === 4);
  return v4.length > 0 ? v4 : addresses;
}

function httpsRequestPinned(
  url: URL,
  addresses: LookupAddress[],
  init: {
    method: string;
    family: 4 | 6;
    headers?: Headers | Record<string, string>;
    body?: string | Buffer | null;
    signal?: AbortSignal;
  },
): Promise<PinnedRequestResult> {
  const agent = new https.Agent({
    keepAlive: false,
    lookup(_hostname, options, callback) {
      if (options?.all) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    },
  });

  const headerBag =
    init.headers instanceof Headers ? init.headers : new Headers(init.headers ?? {});
  if (!headerBag.has('host')) {
    headerBag.set('host', url.host);
  }

  const requestHeaders: Record<string, string> = {};
  headerBag.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      req.destroy(new Error('This operation was aborted'));
    };

    const req = https.request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: requestHeaders,
        agent,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        family: init.family,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          agent.destroy();
          resolve({
            statusCode: res.statusCode ?? 200,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (error) => {
          agent.destroy();
          reject(error);
        });
      },
    );

    req.on('error', (error) => {
      agent.destroy();
      reject(error);
    });

    if (init.signal) {
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        init.signal?.removeEventListener('abort', onAbort);
      });
    }

    if (init.body != null && init.method !== 'GET' && init.method !== 'HEAD') {
      req.write(init.body);
    }
    req.end();
  });
}

function toResponse(result: PinnedRequestResult, finalUrl: string): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }
  const response = new Response(new Uint8Array(result.body), {
    status: result.statusCode,
    headers,
  });
  Object.defineProperty(response, 'url', { value: finalUrl, enumerable: true });
  return response;
}
