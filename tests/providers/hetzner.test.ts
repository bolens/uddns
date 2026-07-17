import { describe, expect, it } from 'vite-plus/test';

import { hetznerProvider } from '../../lib/providers/hetzner.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

type HetznerRecordFixture = {
  id: string;
  type: string;
  name: string;
  value: string;
};

function hzZone(id: string, name: string): Response {
  return jsonResponse({ zone: { id, name } });
}

function hzZones(zones: Array<{ id: string; name: string }>): Response {
  return jsonResponse({ zones });
}

function hzRecords(records: HetznerRecordFixture[]): Response {
  return jsonResponse({ records });
}

function hzConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    hetzner: {
      apiToken: 'hz-token',
      zoneId: 'zone1',
      ...overrides.hetzner,
    },
  });
}

describe('hetzner provider', () => {
  it('requires an API token and a host before contacting the API', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      hetznerProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('HETZNER_API_TOKEN'),
      details: expect.objectContaining({ hasApiToken: false }),
    });

    await expect(
      hetznerProvider.update(hzConfig({ hosts: [], hostname: null }), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    await expect(hetznerProvider.update(hzConfig(), { v4: null, v6: null })).resolves.toMatchObject(
      {
        ok: false,
        message: 'No public IP available',
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates an existing A record through the pinned zone id', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([{ id: 'r1', type: 'A', name: 'home', value: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/r1'),
        response: jsonResponse({ record: { id: 'r1', type: 'A', name: 'home', value: '9.9.9.9' } }),
      },
    ]);

    const result = await hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        zoneId: 'zone1',
        zoneName: 'example.com',
        recordName: 'home',
        results: [
          expect.objectContaining({
            details: expect.objectContaining({ action: 'update', previous: '1.1.1.1' }),
          }),
        ],
      }),
    });

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(put.headers.get('Auth-API-Token')).toBe('hz-token');
    expect(JSON.parse(put.body ?? '{}')).toEqual({
      zone_id: 'zone1',
      type: 'A',
      name: 'home',
      value: '9.9.9.9',
    });
  });

  it('resolves the zone by name and creates missing records', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?name=example.com'),
        response: hzZones([{ id: 'zone1', name: 'example.com' }]),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/records'),
        response: jsonResponse({
          record: { id: 'new1', type: 'A', name: 'home', value: '9.9.9.9' },
        }),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig({ hetzner: { zoneId: null, zoneName: 'example.com' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com -> 9.9.9.9'),
    });

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    expect(JSON.parse(post.body ?? '{}')).toEqual({
      zone_id: 'zone1',
      type: 'A',
      name: 'home',
      value: '9.9.9.9',
    });
  });

  it('skips unchanged records and maps the apex host to @', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([{ id: 'r1', type: 'A', name: '@', value: '9.9.9.9' }]),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('A example.com unchanged'),
      details: expect.objectContaining({ recordName: '@' }),
    });
  });

  it('walks host labels to discover the zone when id/name are unset', async () => {
    const zoneQueries: string[] = [];
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?'),
        response: (url) => {
          const name = new URL(url).searchParams.get('name') ?? '';
          zoneQueries.push(name);
          return name === 'example.com'
            ? hzZones([{ id: 'zone1', name }])
            : jsonResponse({ message: 'zone not found' }, 404);
        },
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([{ id: 'r1', type: 'A', name: 'home.lan', value: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/r1'),
        response: jsonResponse({
          record: { id: 'r1', type: 'A', name: 'home.lan', value: '9.9.9.9' },
        }),
      },
    ]);

    const result = await hetznerProvider.update(
      hzConfig({
        hosts: ['home.lan.example.com'],
        hostname: 'home.lan.example.com',
        hetzner: { zoneId: null },
      }),
      { v4: '9.9.9.9', v6: null },
    );

    expect(result.ok).toBe(true);
    expect(zoneQueries).toEqual(['home.lan.example.com', 'lan.example.com', 'example.com']);
  });

  it('fails with guidance when no zone resolves or the host is outside the zone', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?'),
        response: jsonResponse({ message: 'zone not found' }, 404),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig({ hetzner: { zoneId: null } }), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Could not resolve Hetzner zone'),
      details: expect.objectContaining({ hint: expect.stringContaining('apex domain') }),
    });

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?name=other.net'),
        response: hzZones([{ id: 'zone2', name: 'other.net' }]),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig({ hetzner: { zoneId: null, zoneName: 'other.net' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('not within Hetzner zone other.net'),
    });
  });

  it('strips trailing dots when matching hosts to the zone', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([{ id: 'r1', type: 'A', name: 'home', value: '9.9.9.9' }]),
      },
    ]);

    await expect(
      hetznerProvider.update(
        hzConfig({ hosts: ['home.example.com.'], hostname: 'home.example.com.' }),
        {
          v4: '9.9.9.9',
          v6: null,
        },
      ),
    ).resolves.toMatchObject({ ok: true, skipped: true });
  });

  it('updates A and AAAA independently', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?zone_id=zone1'),
        response: hzRecords([{ id: 'r1', type: 'A', name: 'home', value: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/r1'),
        response: jsonResponse({ record: { id: 'r1', type: 'A', name: 'home', value: '9.9.9.9' } }),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/records'),
        response: jsonResponse({
          record: { id: 'new1', type: 'AAAA', name: 'home', value: '2001:db8::9' },
        }),
      },
    ]);

    const result = await hetznerProvider.update(hzConfig(), {
      v4: '9.9.9.9',
      v6: '2001:db8::9',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('A home.example.com -> 9.9.9.9');
    expect(result.message).toContain('Created AAAA home.example.com -> 2001:db8::9');
  });

  it('surfaces API errors from update and create requests', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?'),
        response: hzRecords([{ id: 'r1', type: 'A', name: 'home', value: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/r1'),
        response: jsonResponse({ error: { message: 'invalid record', code: 422 } }, 422),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('invalid record [code 422]'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'update' }) }),
        ],
      }),
    });

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?'),
        response: hzRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/records'),
        response: textResponse('', 403),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Hetzner API request failed (HTTP 403'),
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
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: jsonResponse({ message: 'Invalid authentication credentials' }, 401),
      },
    ]);

    await expect(hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /zone lookup for zone1.*Invalid authentication credentials/,
    );

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?'),
        response: jsonResponse({ message: 'rate limited' }, 429),
      },
    ]);

    await expect(
      hetznerProvider.update(hzConfig({ hetzner: { zoneId: null, zoneName: 'example.com' } }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).rejects.toThrow(/zone lookup for example\.com.*rate limited/);

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: hzZone('zone1', 'example.com'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/records?'),
        response: jsonResponse({ message: 'forbidden' }, 403),
      },
    ]);

    await expect(hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /A record lookup for home.*forbidden/,
    );

    stubRoutedFetch([
      {
        match: () => true,
        response: textResponse('<html>bad gateway</html>', 502),
      },
    ]);

    await expect(hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /non-JSON \(502/,
    );

    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/zones/zone1'),
        response: jsonResponse({ zone: { id: 123 } }),
      },
    ]);

    await expect(hetznerProvider.update(hzConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /zone response failed validation/i,
    );
  });
});
