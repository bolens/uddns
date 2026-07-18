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
   * When set, dial via pin-on-connect HTTPS (resolve once, connect only to
   * verified addresses). Used for notify webhooks and other untrusted URLs.
   */
  pin?: {
    policy?: import('../url-policy.js').HttpsUrlPolicy;
    lookupHost?: import('../url-policy.js').HostLookupFn;
  };
};

/**
 * Fetch a URL and return the Response, text body, and debug metadata.
 * Every request carries a timeout so providers can never hang a cycle.
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

  try {
    const response = pin
      ? await pinnedHttpsFetch(url, {
          method,
          headers,
          body: typeof fetchInit.body === 'string' ? fetchInit.body : null,
          signal,
          redirect: redirect === 'follow' ? 'follow' : 'error',
          ...pin,
        })
      : await fetch(url, { ...fetchInit, headers, signal, redirect });
    const body = await response.text();
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return {
      response,
      body,
      meta: {
        method,
        url: safeUrl,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        bodyPreview: scrubBodyPreview(body),
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
