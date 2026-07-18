import { describe, expect, it } from 'vite-plus/test';

import { bunnyProvider } from '../../lib/providers/bunny.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch } from '../helpers/fetch.js';

afterEachResetFetch();

type BunnyRecord = {
  Id: number;
  Type: number;
  Name: string;
  Value: string;
  Ttl: number;
};

function zoneWith(records: BunnyRecord[], domain = 'example.com'): Response {
  return jsonResponse({ Domain: domain, Records: records });
}

function bunnyConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    bunny: {
      apiKey: 'bunny-key',
      zoneId: 7,
      domain: 'example.com',
      ...overrides.bunny,
    },
  });
}

describe('bunny provider', () => {
  it('requires api key, zone id, domain, host, and IP', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      bunnyProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('BUNNY_API_KEY'),
    });

    await expect(
      bunnyProvider.update(bunnyConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates an existing A record with AccessKey auth', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([{ Id: 11, Type: 0, Name: 'home', Value: '1.1.1.1', Ttl: 300 }]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/dnszone/7/records/11'),
        response: new Response(null, { status: 204 }),
      },
    ]);

    const result = await bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null });
    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    expect(getCall(fetchMock, 0).headers.get('AccessKey')).toBe('bunny-key');
    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    expect(JSON.parse(post.body ?? '{}')).toEqual({
      Type: 0,
      Name: 'home',
      Value: '9.9.9.9',
      Ttl: 300,
    });
  });

  it('skips unchanged records and creates missing ones with PUT', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([{ Id: 11, Type: 0, Name: 'home', Value: '9.9.9.9', Ttl: 300 }]),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });

    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/dnszone/7/records'),
        response: jsonResponse({ Id: 99 }),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });
    expect(fetchMock.mock.calls.some(([, init = {}]) => (init.method ?? 'GET') === 'PUT')).toBe(
      true,
    );
  });

  it('matches API record names that include a trailing root dot', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([{ Id: 11, Type: 0, Name: 'home.', Value: '9.9.9.9', Ttl: 300 }]),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it('fails when BUNNY_DOMAIN does not match the zone Domain', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([], 'other.com'),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('not BUNNY_DOMAIN'),
    });
  });

  it('fails when the zone payload is invalid', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: jsonResponse({ Records: 'nope' }),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Bunny DNS zone lookup failed',
    });
  });

  it('returns a graceful failure when zone lookup returns non-JSON', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: new Response('<html>nope</html>', { status: 503 }),
      },
    ]);

    await expect(
      bunnyProvider.update(bunnyConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Bunny DNS zone lookup failed',
      details: expect.objectContaining({ http: expect.objectContaining({ status: 503 }) }),
    });
  });

  it('uses empty Name for apex hosts and numeric AAAA type', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dnszone/7'),
        response: zoneWith([]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/dnszone/7/records'),
        response: jsonResponse({ Id: 1 }),
      },
    ]);

    await bunnyProvider.update(bunnyConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
      v4: null,
      v6: '2001:db8::1',
    });

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(JSON.parse(put.body ?? '{}')).toMatchObject({
      Type: 1,
      Name: '',
      Value: '2001:db8::1',
    });
  });
});
