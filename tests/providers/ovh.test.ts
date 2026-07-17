import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vite-plus/test';

import { ovhProvider } from '../../lib/providers/ovh.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import {
  fetchInputUrl,
  getCall,
  jsonResponse,
  stubRoutedFetch,
  textResponse,
  type FetchInput,
} from '../helpers/fetch.js';

afterEachResetFetch();

function ovhConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    ovh: {
      endpoint: 'eu',
      applicationKey: 'app-key',
      applicationSecret: 'app-secret',
      consumerKey: 'consumer-key',
      zone: 'example.com',
      ...overrides.ovh,
    },
  });
}

function expectedSignature(method: string, url: string, body: string, timestamp: number): string {
  return `$1$${createHash('sha1')
    .update(`app-secret+consumer-key+${method}+${url}+${body}+${timestamp}`)
    .digest('hex')}`;
}

describe('ovh provider', () => {
  it('requires credentials, zone, host, and IP', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      ovhProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('application'),
    });

    await expect(
      ovhProvider.update(ovhConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updates an existing A record, signs requests, and refreshes the zone', async () => {
    const timestamp = 1_700_000_000;
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/auth/time'),
        response: textResponse(String(timestamp)),
      },
      {
        match: (url, method) =>
          method === 'GET' && url.includes('/domain/zone/example.com/record?fieldType=A'),
        response: jsonResponse([55]),
      },
      {
        match: (url, method) =>
          method === 'GET' && url.endsWith('/domain/zone/example.com/record/55'),
        response: jsonResponse({ id: 55, target: '1.1.1.1', ttl: 300 }),
      },
      {
        match: (url, method) =>
          method === 'PUT' && url.endsWith('/domain/zone/example.com/record/55'),
        response: jsonResponse(null),
      },
      {
        match: (url, method) =>
          method === 'POST' && url.endsWith('/domain/zone/example.com/refresh'),
        response: jsonResponse(null),
      },
    ]);

    const result = await ovhProvider.update(ovhConfig(), { v4: '9.9.9.9', v6: null });
    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(put.headers.get('X-Ovh-Application')).toBe('app-key');
    expect(put.headers.get('X-Ovh-Consumer')).toBe('consumer-key');
    expect(put.headers.get('X-Ovh-Timestamp')).toBe(String(timestamp));
    expect(put.headers.get('X-Ovh-Signature')).toBe(
      expectedSignature(
        'PUT',
        'https://eu.api.ovh.com/1.0/domain/zone/example.com/record/55',
        put.body ?? '',
        timestamp,
      ),
    );
    expect(
      fetchMock.mock.calls.some(
        ([input, init = {}]) =>
          fetchInputUrl(input as FetchInput).endsWith('/domain/zone/example.com/refresh') &&
          (init.method ?? 'GET') === 'POST',
      ),
    ).toBe(true);
  });

  it('fails when record listing returns a non-ok status', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/auth/time'),
        response: textResponse('1700000000'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/record?fieldType=A'),
        response: jsonResponse({ message: 'nope' }, 403),
      },
    ]);

    await expect(
      ovhProvider.update(ovhConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('OVH record lookup failed (HTTP 403)'),
    });
  });

  it('fails when record id listing is invalid', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/auth/time'),
        response: textResponse('1700000000'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/record?fieldType=A'),
        response: jsonResponse({ bad: true }),
      },
    ]);

    await expect(
      ovhProvider.update(ovhConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'OVH returned invalid record IDs',
    });
  });

  it('skips unchanged records without refreshing', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/auth/time'),
        response: textResponse('1700000000'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/record?fieldType=A'),
        response: jsonResponse([55]),
      },
      {
        match: (url, method) => method === 'GET' && url.endsWith('/record/55'),
        response: jsonResponse({ id: 55, target: '9.9.9.9', ttl: 300 }),
      },
    ]);

    await expect(
      ovhProvider.update(ovhConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        fetchInputUrl(input as FetchInput).includes('/refresh'),
      ),
    ).toBe(false);
  });

  it('creates missing records with POST then refreshes', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/auth/time'),
        response: textResponse('1700000000'),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('/record?fieldType=A'),
        response: jsonResponse([]),
      },
      {
        match: (url, method) =>
          method === 'POST' && url.endsWith('/domain/zone/example.com/record'),
        response: jsonResponse(99),
      },
      {
        match: (url, method) =>
          method === 'POST' && url.endsWith('/domain/zone/example.com/refresh'),
        response: jsonResponse(null),
      },
    ]);

    await expect(
      ovhProvider.update(ovhConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(
        ([input, init = {}]) =>
          fetchInputUrl(input as FetchInput).endsWith('/domain/zone/example.com/record') &&
          (init.method ?? 'GET') === 'POST',
      ),
    );
    expect(JSON.parse(post.body ?? '{}')).toMatchObject({
      fieldType: 'A',
      subDomain: 'home',
      target: '9.9.9.9',
      ttl: 300,
    });
  });
});
