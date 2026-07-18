import { describe, expect, it } from 'vite-plus/test';

import { contaboProvider } from '../../lib/providers/contabo.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import {
  fetchInputUrl,
  getCall,
  jsonResponse,
  stubRoutedFetch,
  type FetchInput,
} from '../helpers/fetch.js';

afterEachResetFetch();

function contaboConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    contabo: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      apiUser: 'api-user',
      apiPassword: 'api-password',
      zone: 'example.com',
      ...overrides.contabo,
    },
  });
}

function authAndDnsRoutes(options: {
  records: Array<{
    recordId: number;
    name: string;
    type: string;
    ttl: number;
    data: string;
  }>;
  mutateMethod?: 'PATCH' | 'POST';
  mutatePathEndsWith?: string;
}) {
  return [
    {
      match: (url: string, method: string) =>
        method === 'POST' && url.includes('/protocol/openid-connect/token'),
      response: jsonResponse({ access_token: 'access-token', expires_in: 3600 }),
    },
    {
      match: (url: string, method: string) =>
        method === 'GET' && url.includes('/dns/zones/example.com/records'),
      response: jsonResponse({ data: options.records }),
    },
    ...(options.mutateMethod
      ? [
          {
            match: (url: string, method: string) =>
              method === options.mutateMethod &&
              url.endsWith(options.mutatePathEndsWith ?? '/records'),
            response: jsonResponse({}),
          },
        ]
      : []),
  ];
}

describe('contabo provider', () => {
  it('requires OAuth credentials, zone, host, and IP', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      contaboProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('OAuth'),
    });

    await expect(
      contaboProvider.update(contaboConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authenticates then patches an existing A record with x-request-id', async () => {
    const fetchMock = stubRoutedFetch(
      authAndDnsRoutes({
        records: [{ recordId: 11, name: 'home', type: 'A', ttl: 300, data: '1.1.1.1' }],
        mutateMethod: 'PATCH',
        mutatePathEndsWith: '/records/11',
      }),
    );

    const result = await contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null });
    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    const tokenCall = getCall(fetchMock, 0);
    expect(tokenCall.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(tokenCall.init.body).toBeInstanceOf(URLSearchParams);
    expect((tokenCall.init.body as URLSearchParams).get('grant_type')).toBe('password');

    const list = getCall(fetchMock, 1);
    expect(list.headers.get('Authorization')).toBe('Bearer access-token');
    expect(list.headers.get('x-request-id')).toEqual(expect.any(String));
    expect(list.url.searchParams.get('search')).toBe('home.example.com');
    expect(list.url.searchParams.get('size')).toBe('100');

    const patch = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PATCH'),
    );
    expect(patch.headers.get('x-request-id')).toEqual(expect.any(String));
    expect(JSON.parse(patch.body ?? '{}')).toEqual({
      type: 'A',
      ttl: 300,
      prio: 0,
      data: '9.9.9.9',
    });
  });

  it('skips unchanged records and creates missing ones', async () => {
    stubRoutedFetch(
      authAndDnsRoutes({
        records: [{ recordId: 11, name: 'home', type: 'A', ttl: 300, data: '9.9.9.9' }],
      }),
    );

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });

    const fetchMock = stubRoutedFetch(
      authAndDnsRoutes({
        records: [],
        mutateMethod: 'POST',
        mutatePathEndsWith: '/dns/zones/example.com/records',
      }),
    );

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    // first POST is token; find DNS POST
    const dnsPostIndex = fetchMock.mock.calls.findIndex(
      ([input, init = {}]) =>
        fetchInputUrl(input as FetchInput).includes('/dns/zones/') &&
        (init.method ?? 'GET') === 'POST',
    );
    const dnsPost = getCall(fetchMock, dnsPostIndex);
    expect(JSON.parse(dnsPost.body ?? '{}')).toMatchObject({
      name: 'home',
      type: 'A',
      data: '9.9.9.9',
    });
    expect(post).toBeDefined();
  });

  it('matches FQDN record names from Contabo list responses', async () => {
    stubRoutedFetch(
      authAndDnsRoutes({
        records: [
          {
            recordId: 11,
            name: 'home.example.com',
            type: 'A',
            ttl: 300,
            data: '9.9.9.9',
          },
        ],
      }),
    );

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it('rejects hosts outside CONTABO_ZONE', async () => {
    await expect(
      contaboProvider.update(contaboConfig({ contabo: { zone: 'other.net' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('outside CONTABO_ZONE'),
    });
  });

  it('matches apex records as zone FQDN or @', async () => {
    stubRoutedFetch(
      authAndDnsRoutes({
        records: [{ recordId: 11, name: 'example.com', type: 'A', ttl: 300, data: '9.9.9.9' }],
      }),
    );

    await expect(
      contaboProvider.update(contaboConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it('does not PATCH apex when updating a subdomain even if search returns @', async () => {
    const fetchMock = stubRoutedFetch(
      authAndDnsRoutes({
        records: [
          { recordId: 1, name: '@', type: 'A', ttl: 300, data: '1.1.1.1' },
          { recordId: 2, name: 'home', type: 'A', ttl: 300, data: '1.1.1.1' },
        ],
        mutateMethod: 'PATCH',
        mutatePathEndsWith: '/records/2',
      }),
    );

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    const patchCalls = fetchMock.mock.calls.filter(
      ([, init = {}]) => (init.method ?? 'GET') === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    expect(fetchInputUrl(patchCalls[0]![0] as FetchInput)).toContain('/records/2');
  });

  it('fails when DNS record listing is invalid', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'POST' && url.includes('/token'),
        response: jsonResponse({ access_token: 'access-token' }),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/dns/zones/'),
        response: jsonResponse({ data: 'bad' }),
      },
    ]);

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Contabo record lookup failed',
    });
  });

  it('fails when DNS record listing returns non-JSON', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'POST' && url.includes('/token'),
        response: jsonResponse({ access_token: 'access-token' }),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/dns/zones/'),
        response: new Response('<html>oops</html>', { status: 200 }),
      },
    ]);

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Contabo record lookup failed',
    });
  });

  it('fails when OAuth token exchange fails', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'POST' && url.includes('/token'),
        response: jsonResponse({ error: 'invalid_client' }, 401),
      },
    ]);

    await expect(
      contaboProvider.update(contaboConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Contabo OAuth authentication failed',
    });
  });
});
