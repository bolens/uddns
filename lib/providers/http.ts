/**
 * Low-level HTTP helpers shared by providers.
 */

export const userAgent = 'ddns-updater/2.0';

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

/**
 * Fetch a URL and return the Response, text body, and debug metadata.
 */
export async function request(url: string | URL, init: RequestInit = {}): Promise<RequestResult> {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', userAgent);
  }

  const method = (init.method ?? 'GET').toUpperCase();
  const safeUrl = sanitizeUrl(url);
  const started = Date.now();

  try {
    const response = await fetch(url, { ...init, headers });
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
    const reason = error instanceof Error ? error.message : String(error);
    const network =
      error && typeof error === 'object'
        ? (error as {
            code?: string | number;
            errno?: string | number;
            syscall?: string;
            hostname?: string;
          })
        : {};

    throw new HttpError(`HTTP ${method} ${safeUrl} failed after ${durationMs}ms: ${reason}`, {
      cause: error,
      ...(network.code !== undefined ? { code: network.code } : {}),
      ...(network.errno !== undefined ? { errno: network.errno } : {}),
      ...(network.syscall !== undefined ? { syscall: network.syscall } : {}),
      ...(network.hostname !== undefined ? { hostname: network.hostname } : {}),
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
      if (/pass(word)?|token|secret|auth|key/i.test(key)) {
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
