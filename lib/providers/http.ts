/**
 * Low-level HTTP helpers shared by providers.
 */

import { errorMessage, networkErrorFields } from '../errors.js';
import { isSensitiveKey } from '../sensitive.js';

export const userAgent = 'uDDNS/2.0.0';

/** Default cap on any single provider/API request so a hung endpoint cannot stall a cycle. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RequestMeta = {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  bodyPreview: string;
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
};

/**
 * Fetch a URL and return the Response, text body, and debug metadata.
 * Every request carries a timeout so providers can never hang a cycle.
 */
export async function request(
  url: string | URL,
  init: RequestInitWithTimeout = {},
): Promise<RequestResult> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...fetchInit } = init;
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

  try {
    const response = await fetch(url, { ...fetchInit, headers, signal });
    const body = await response.text();
    return {
      response,
      body,
      meta: {
        method,
        url: safeUrl,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        bodyPreview: truncateBody(body),
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

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
