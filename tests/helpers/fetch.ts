import { vi, type Mock } from 'vite-plus/test';

import { setRequestFetchOverride } from '../../lib/providers/http.js';

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export type FetchInput = Parameters<typeof fetch>[0];
export type FetchImpl = (input: FetchInput, init?: RequestInit) => Promise<Response> | Response;

export function stubFetch(
  impl: FetchImpl,
): Mock<(input: FetchInput, init?: RequestInit) => Promise<Response>> {
  const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) =>
    Promise.resolve(impl(input, init)),
  );
  vi.stubGlobal('fetch', fetchMock);
  setRequestFetchOverride(fetchMock);
  return fetchMock;
}

export function fetchInputUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

export type FetchRoute = {
  match: (url: string, method: string) => boolean;
  response: Response | ((url: string, init?: RequestInit) => Response);
};

/** Route fetch calls by URL/method; unexpected calls get a loud 500 body. */
export function stubRoutedFetch(routes: FetchRoute[]) {
  return stubFetch((input: FetchInput, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (route.match(url, method)) {
        return typeof route.response === 'function'
          ? route.response(url, init)
          : route.response.clone();
      }
    }
    return textResponse(`unexpected ${method} ${url}`, 500);
  });
}

function asUrl(input: unknown): URL {
  return new URL(String(input));
}

function decodeBasicAuth(
  headers: RequestInit['headers'] | undefined,
): { user: string; pass: string } | null {
  const value = new Headers(headers).get('Authorization');
  if (!value?.startsWith('Basic ')) {
    return null;
  }

  const decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  if (index === -1) {
    return { user: decoded, pass: '' };
  }

  return {
    user: decoded.slice(0, index),
    pass: decoded.slice(index + 1),
  };
}

export function getCall(
  fetchMock: { mock: { calls: unknown[][] } },
  call = 0,
): {
  url: URL;
  init: RequestInit;
  method: string;
  headers: Headers;
  body: string | null;
  auth: { user: string; pass: string } | null;
} {
  const entry = fetchMock.mock.calls[call] ?? [];
  const input = entry[0];
  const init = (entry[1] ?? {}) as RequestInit;
  return {
    url: asUrl(input),
    init,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? init.body : null,
    auth: decodeBasicAuth(init.headers),
  };
}
