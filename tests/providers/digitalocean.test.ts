import { describe, expect, it } from 'vite-plus/test';

import { digitaloceanProvider } from '../../lib/providers/digitalocean.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

type DoRecordFixture = {
  id: number;
  type: string;
  name: string;
  data: string;
};

function doRecords(records: DoRecordFixture[]): Response {
  return jsonResponse({ domain_records: records });
}

function doConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    digitalocean: {
      apiToken: 'do-token',
      domain: 'example.com',
      ...overrides.digitalocean,
    },
  });
}

describe('digitalocean provider', () => {
  it('requires a token and a host before contacting the API', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      digitaloceanProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('DIGITALOCEAN_API_TOKEN'),
      details: expect.objectContaining({ hasApiToken: false }),
    });

    await expect(
      digitaloceanProvider.update(doConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: null, v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IP available',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates an existing A record with a bearer token', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) =>
          method === 'GET' && url.includes('/domains/example.com/records?type=A'),
        response: doRecords([{ id: 101, type: 'A', name: 'home', data: '1.1.1.1' }]),
      },
      {
        match: (url, method) =>
          method === 'PUT' && url.endsWith('/domains/example.com/records/101'),
        response: jsonResponse({
          domain_record: { id: 101, type: 'A', name: 'home', data: '9.9.9.9' },
        }),
      },
    ]);

    const result = await digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        domain: 'example.com',
        recordName: 'home',
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              action: 'update',
              previous: '1.1.1.1',
              recordId: 101,
            }),
          }),
        ],
      }),
    });

    const lookup = getCall(fetchMock, 0);
    expect(lookup.headers.get('Authorization')).toBe('Bearer do-token');
    expect(lookup.url.searchParams.get('name')).toBe('home.example.com');

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(JSON.parse(put.body ?? '{}')).toEqual({ type: 'A', data: '9.9.9.9' });
  });

  it('skips unchanged records and creates missing ones', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: doRecords([{ id: 101, type: 'A', name: 'home', data: '9.9.9.9' }]),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });

    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: doRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/domains/example.com/records'),
        response: jsonResponse({
          domain_record: { id: 5, type: 'A', name: 'home', data: '9.9.9.9' },
        }),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com -> 9.9.9.9'),
    });

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    expect(JSON.parse(post.body ?? '{}')).toEqual({ type: 'A', name: 'home', data: '9.9.9.9' });
  });

  it('maps the apex host to @ and updates A and AAAA independently', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=A&'),
        response: doRecords([{ id: 1, type: 'A', name: '@', data: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('type=AAAA'),
        response: doRecords([]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/1'),
        response: jsonResponse({ domain_record: { id: 1, type: 'A', name: '@', data: '9.9.9.9' } }),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/records'),
        response: jsonResponse({
          domain_record: { id: 2, type: 'AAAA', name: '@', data: '2001:db8::9' },
        }),
      },
    ]);

    const result = await digitaloceanProvider.update(
      doConfig({ hosts: ['example.com'], hostname: 'example.com' }),
      { v4: '9.9.9.9', v6: '2001:db8::9' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('A example.com -> 9.9.9.9');
    expect(result.message).toContain('Created AAAA example.com -> 2001:db8::9');
    expect(result.details).toMatchObject({ recordName: '@' });
  });

  it('derives short FQDNs and requires an explicit domain for deeper names', async () => {
    stubRoutedFetch([
      {
        match: (url, method) =>
          method === 'GET' && url.includes('/domains/example.com/records?type=A'),
        response: doRecords([{ id: 7, type: 'A', name: 'home', data: '9.9.9.9' }]),
      },
    ]);

    await expect(
      digitaloceanProvider.update(
        makeConfig({
          hosts: ['home.example.com'],
          digitalocean: { apiToken: 'do-token' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      details: expect.objectContaining({ domain: 'example.com', recordName: 'home' }),
    });

    await expect(
      digitaloceanProvider.update(
        makeConfig({
          hosts: ['vpn.home.example.com'],
          digitalocean: { apiToken: 'do-token' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Set DIGITALOCEAN_DOMAIN'),
    });

    stubRoutedFetch([
      {
        match: (url, method) =>
          method === 'GET' && url.includes('/domains/example.com/records?type=A'),
        response: doRecords([{ id: 7, type: 'A', name: 'vpn.home', data: '9.9.9.9' }]),
      },
    ]);

    await expect(
      digitaloceanProvider.update(
        makeConfig({
          hosts: ['vpn.home.example.com'],
          digitalocean: { apiToken: 'do-token', domain: 'example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      details: expect.objectContaining({ domain: 'example.com', recordName: 'vpn.home' }),
    });
  });

  it('fails with guidance for underivable domains and hosts outside the domain', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      digitaloceanProvider.update(
        makeConfig({
          hosts: ['home'],
          hostname: 'home',
          digitalocean: { apiToken: 'do-token' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Set DIGITALOCEAN_DOMAIN'),
      details: expect.objectContaining({ hint: expect.stringContaining('registered domain') }),
    });

    await expect(
      digitaloceanProvider.update(doConfig({ digitalocean: { domain: 'other.net' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('not within DigitalOcean domain other.net'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips trailing dots when matching hosts to the domain', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: doRecords([{ id: 101, type: 'A', name: 'home', data: '9.9.9.9' }]),
      },
    ]);

    await expect(
      digitaloceanProvider.update(
        doConfig({ hosts: ['home.example.com.'], hostname: 'home.example.com.' }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it('strips trailing dots from DIGITALOCEAN_DOMAIN', async () => {
    stubRoutedFetch([
      {
        match: (url, method) =>
          method === 'GET' && url.includes('/domains/example.com/records?type=A'),
        response: doRecords([{ id: 101, type: 'A', name: 'home', data: '9.9.9.9' }]),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig({ digitalocean: { domain: 'example.com.' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it('surfaces API errors from update and create requests', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: doRecords([{ id: 101, type: 'A', name: 'home', data: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/101'),
        response: jsonResponse(
          { id: 'unprocessable_entity', message: 'Data needs to be valid' },
          422,
        ),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Data needs to be valid [unprocessable_entity]'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'update' }) }),
        ],
      }),
    });

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: doRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/records'),
        response: jsonResponse({}, 500),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('DigitalOcean API request failed (HTTP 500'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'create' }) }),
        ],
      }),
    });
  });

  it('throws on rejected lookups, non-JSON bodies, and malformed shapes', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A'),
        response: jsonResponse({ id: 'unauthorized', message: 'Unable to authenticate you' }, 401),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).rejects.toThrow(/record lookup for home\.example\.com.*Unable to authenticate you/);

    stubRoutedFetch([
      {
        match: () => true,
        response: textResponse('<html>bad gateway</html>', 502),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).rejects.toThrow(/non-JSON \(502/);

    stubRoutedFetch([
      {
        match: () => true,
        response: jsonResponse({ domain_records: [{ id: 'not-a-number' }] }),
      },
    ]);

    await expect(
      digitaloceanProvider.update(doConfig(), { v4: '9.9.9.9', v6: null }),
    ).rejects.toThrow(/records response failed validation/i);
  });
});
