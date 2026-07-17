import { describe, expect, it } from 'vite-plus/test';

import { gandiProvider } from '../../lib/providers/gandi.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch } from '../helpers/fetch.js';

afterEachResetFetch();

function gandiRecord(values: string[], ttl = 300): Response {
  return jsonResponse({ rrset_values: values, rrset_ttl: ttl });
}

function gandiConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    gandi: {
      apiToken: 'gandi-token',
      domain: 'example.com',
      ...overrides.gandi,
    },
  });
}

describe('gandi provider', () => {
  it('requires a token, a domain, and a host before contacting the API', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      gandiProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('GANDI_API_TOKEN'),
    });

    await expect(
      gandiProvider.update(gandiConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    await expect(
      gandiProvider.update(gandiConfig(), { v4: null, v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IP available',
      details: expect.objectContaining({ hostname: 'home.example.com' }),
    });

    await expect(
      gandiProvider.update(gandiConfig({ gandi: { domain: 'other.net' } }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('outside GANDI_DOMAIN'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates an existing A record with a bearer token', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) =>
          method === 'GET' && url.endsWith('/livedns/domains/example.com/records/home/A'),
        response: gandiRecord(['1.1.1.1']),
      },
      {
        match: (url, method) =>
          method === 'PUT' && url.endsWith('/livedns/domains/example.com/records/home/A'),
        response: jsonResponse({ message: 'DNS Record Created' }, 201),
      },
    ]);

    const result = await gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({ domain: 'example.com', name: 'home' }),
    });

    const lookup = getCall(fetchMock, 0);
    expect(lookup.headers.get('Authorization')).toBe('Bearer gandi-token');

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(put.headers.get('Authorization')).toBe('Bearer gandi-token');
    expect(JSON.parse(put.body ?? '{}')).toEqual({ rrset_ttl: 300, rrset_values: ['9.9.9.9'] });
  });

  it('skips unchanged records and creates missing ones on 404', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: gandiRecord(['9.9.9.9']),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('A home.example.com unchanged (9.9.9.9)'),
    });

    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'Record not found' }, 404),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'DNS Record Created' }, 201),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
    });

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(JSON.parse(put.body ?? '{}')).toEqual({ rrset_ttl: 300, rrset_values: ['9.9.9.9'] });
  });

  it('replaces records whose value matches but whose TTL differs', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: gandiRecord(['9.9.9.9'], 600),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'DNS Record Created' }, 201),
      },
    ]);

    const result = await gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeFalsy();
    expect(fetchMock.mock.calls.some(([, init = {}]) => (init.method ?? 'GET') === 'PUT')).toBe(
      true,
    );
  });

  it('updates A and AAAA independently for dual-stack hosts', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: gandiRecord(['1.1.1.1']),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'DNS Record Created' }, 201),
      },
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/AAAA'),
        response: gandiRecord(['2001:db8::9']),
      },
    ]);

    const result = await gandiProvider.update(gandiConfig(), {
      v4: '9.9.9.9',
      v6: '2001:db8::9',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('A home.example.com -> 9.9.9.9');
    expect(result.message).toContain('AAAA home.example.com unchanged (2001:db8::9)');
  });

  it('maps the apex host to @ in the record URL', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/%40/A'),
        response: gandiRecord(['9.9.9.9']),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({ ok: true, skipped: true });

    expect(getCall(fetchMock, 0).url.pathname).toContain('/records/%40/A');
  });

  it('surfaces lookup, validation, and update failures', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'server error' }, 500),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Gandi record lookup failed (HTTP 500)'),
    });

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: jsonResponse({ rrset_values: 'not-an-array' }),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Gandi returned invalid A record data'),
    });

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'Record not found' }, 404),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/home/A'),
        response: jsonResponse({ message: 'forbidden' }, 403),
      },
    ]);

    await expect(
      gandiProvider.update(gandiConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Gandi record update failed (HTTP 403)'),
    });
  });
});
