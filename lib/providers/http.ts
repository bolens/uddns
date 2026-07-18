/**
 * Low-level HTTP helpers shared by providers.
 */

import { errorMessage, networkErrorFields } from '../errors.js';
import { pinnedHttpsFetch } from '../safe-https.js';
import { isSensitiveKey } from '../sensitive.js';
import packageJson from '../../package.json' with { type: 'json' };

export const userAgent = `uDDNS/${packageJson.version}`;

/** Default cap on any single provider/API request so a hung endpoint cannot stall a cycle. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RequestMeta = {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  bodyPreview: string;
  retryAfterMs?: number;
};

export class HttpError extends Error {
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  hostname?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      code?: string | number;
      errno?: string | number;
      syscall?: string;
      hostname?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    if (options?.code !== undefined) {
      this.code = options.code;
    }
    if (options?.errno !== undefined) {
      this.errno = options.errno;
    }
    if (options?.syscall !== undefined) {
      this.syscall = options.syscall;
    }
    if (options?.hostname !== undefined) {
      this.hostname = options.hostname;
    }
  }
}

export type RequestResult = {
  response: Response;
  body: string;
  meta: RequestMeta;
};

export type RequestInitWithTimeout = RequestInit & {
  /** Overall deadline for the request; combined with any caller-provided signal. */
  timeoutMs?: number;
  /**
   * Pin-on-connect HTTPS (default). Resolves DNS once and dials only verified
   * addresses so credentials cannot follow a rebinding race onto a private host.
   * Pass `false` only for test stubs that replace the transport (see stubFetch).
   */
  pin?:
    | false
    | {
        policy?: import('../url-policy.js').HttpsUrlPolicy;
        lookupHost?: import('../url-policy.js').HostLookupFn;
      };
};

/** Test-only transport override installed by `stubFetch`. */
let requestFetchOverride: typeof globalThis.fetch | null = null;

/** Install/clear the fetch used by {@link request} in unit tests. */
export function setRequestFetchOverride(fetchImpl: typeof globalThis.fetch | null): void {
  requestFetchOverride = fetchImpl;
}

/**
 * Fetch a URL and return the Response, text body, and debug metadata.
 * Every request carries a timeout so providers can never hang a cycle.
 * Production dials via pin-on-connect HTTPS unless `pin: false` or a test override.
 */
export async function request(
  url: string | URL,
  init: RequestInitWithTimeout = {},
): Promise<RequestResult> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, pin, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', userAgent);
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = fetchInit.signal
    ? AbortSignal.any([fetchInit.signal, timeoutSignal])
    : timeoutSignal;

  const method = (fetchInit.method ?? 'GET').toUpperCase();
  const safeUrl = sanitizeUrl(url);
  const started = Date.now();
  // Providers send Bearer/Basic/query tokens; never follow redirects that could
  // move those credentials (or a forged "good" body) onto another host.
  const redirect = fetchInit.redirect ?? 'error';
  const body =
    typeof fetchInit.body === 'string'
      ? fetchInit.body
      : fetchInit.body instanceof Uint8Array
        ? Buffer.from(fetchInit.body)
        : null;

  try {
    const response = await dispatchRequest(url, {
      method,
      headers,
      body,
      signal,
      redirect,
      pin,
      fetchInit,
    });
    const text = await response.text();
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return {
      response,
      body: text,
      meta: {
        method,
        url: safeUrl,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        bodyPreview: scrubBodyPreview(text),
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      },
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const reason = errorMessage(error);
    const network = networkErrorFields(error);

    throw new HttpError(`HTTP ${method} ${safeUrl} failed after ${durationMs}ms: ${reason}`, {
      cause: error,
      ...network,
    });
  }
}

async function dispatchRequest(
  url: string | URL,
  options: {
    method: string;
    headers: Headers;
    body: string | Buffer | null;
    signal: AbortSignal;
    redirect: 'error' | 'follow' | 'manual';
    pin: RequestInitWithTimeout['pin'];
    fetchInit: RequestInit;
  },
): Promise<Response> {
  const { method, headers, body, signal, redirect, pin, fetchInit } = options;
  const fetchArgs: RequestInit = {
    ...fetchInit,
    headers,
    signal,
    redirect,
  };
  if (body != null) {
    fetchArgs.body = body;
  }
  if (requestFetchOverride) {
    return await requestFetchOverride(url, fetchArgs);
  }
  if (pin === false) {
    return await fetch(url, fetchArgs);
  }
  const pinOpts = pin ?? {};
  return await pinnedHttpsFetch(url, {
    method,
    headers,
    body,
    signal,
    redirect: redirect === 'follow' ? 'follow' : 'error',
    ...pinOpts,
  });
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Throw an Error that carries HTTP status / Retry-After for updater retries. */
export function throwWithHttpMeta(message: string, meta: RequestMeta): never {
  const error = new Error(message);
  Object.assign(error, {
    status: meta.status,
    details: { http: meta },
    ...(meta.retryAfterMs !== undefined ? { retryAfterMs: meta.retryAfterMs } : {}),
  });
  throw error;
}

/**
 * Strip credentials and sensitive query params before logging a URL.
 */
export function sanitizeUrl(value: string | URL): string {
  try {
    const url = new URL(String(value));
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }

    const sensitiveKeys: string[] = [];
    for (const key of url.searchParams.keys()) {
      if (isSensitiveKey(key)) {
        sensitiveKeys.push(key);
      }
    }
    for (const key of sensitiveKeys) {
      url.searchParams.set(key, '[redacted]');
    }

    return url.toString();
  } catch {
    return String(value).replace(/\/\/([^/@]+)@/g, '//***@');
  }
}

export function truncateBody(body: string, max = 800): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…(+${trimmed.length - max} chars)`;
}

/** Truncate response bodies and scrub common auth tokens before they hit logs/meta. */
export function scrubBodyPreview(body: string, max = 800): string {
  return truncateBody(body, max)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, '$1 [redacted]')
    .replace(/"([A-Za-z0-9_-]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g, (match, key: string) =>
      isSensitiveKey(key) ? `"${key}":"[redacted]"` : match,
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
