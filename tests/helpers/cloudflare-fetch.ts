import { jsonResponse, stubFetch, type FetchInput } from './fetch.js';

export function cfOk(result: unknown, status = 200): Response {
  return jsonResponse({ success: true, result, errors: [], messages: [] }, status);
}

export function cfErr(errors: Array<{ code?: number; message?: string }>, status = 400): Response {
  return jsonResponse({ success: false, result: null, errors, messages: [] }, status);
}

export function cfZones(zones: Array<{ id: string; name: string }>): Response {
  return cfOk(zones);
}

export function cfRecords(
  records: Array<{
    id: string;
    content: string;
    proxied?: boolean;
    ttl?: number;
    type?: string;
    name?: string;
  }>,
): Response {
  return cfOk(
    records.map((record) => ({
      proxied: false,
      ...record,
    })),
  );
}

export type CfRoute = {
  match: (url: string, method: string) => boolean;
  response: Response | ((url: string, init?: RequestInit) => Response);
};

export function stubCloudflareFetch(routes: CfRoute[]) {
  return stubFetch((input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (route.match(url, method)) {
        return typeof route.response === 'function'
          ? route.response(url, init)
          : route.response.clone();
      }
    }
    return jsonResponse(
      {
        success: false,
        errors: [{ message: `unexpected ${method} ${url}` }],
      },
      500,
    );
  });
}

export function stubCloudflareResponse(response: Response) {
  return stubCloudflareFetch([{ match: () => true, response }]);
}

export function parseJsonBody(body: string | null): unknown {
  return JSON.parse(body ?? '{}');
}
