import { describe, expect, it } from 'vite-plus/test';

import { linodeProvider } from '../../lib/providers/linode.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch } from '../helpers/fetch.js';

afterEachResetFetch();

type LinodeRecord = {
  id: number;
  type: string;
  name: string;
  target: string;
  ttl_sec?: number;
};

function linodeRecords(records: LinodeRecord[]): Response {
  return jsonResponse({ data: records });
}

function linodeConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    linode: {
      apiToken: 'linode-token',
      domainId: 42,
      domain: 'example.com',
      ...overrides.linode,
    },
  });
}

describe('linode provider', () => {
  it('requires token, domain id, domain, host, and IP', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      linodeProvider.update(makeConfig(), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('LINODE_API_TOKEN'),
    });

    await expect(
      linodeProvider.update(linodeConfig({ hosts: [], hostname: null }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    await expect(
      linodeProvider.update(linodeConfig(), { v4: null, v6: null }),
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
          method === 'GET' && url.includes('/domains/42/records?type=A&name=home'),
        response: linodeRecords([
          { id: 101, type: 'A', name: 'home', target: '1.1.1.1', ttl_sec: 300 },
        ]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/domains/42/records/101'),
        response: jsonResponse({
          data: { id: 101, type: 'A', name: 'home', target: '9.9.9.9', ttl_sec: 300 },
        }),
      },
    ]);

    const result = await linodeProvider.update(linodeConfig(), { v4: '9.9.9.9', v6: null });
    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });

    expect(getCall(fetchMock, 0).headers.get('Authorization')).toBe('Bearer linode-token');
    const put = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PUT'),
    );
    expect(JSON.parse(put.body ?? '{}')).toEqual({
      type: 'A',
      name: 'home',
      target: '9.9.9.9',
      ttl_sec: 300,
    });
  });

  it('skips unchanged records and creates missing ones', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=A'),
        response: linodeRecords([
          { id: 101, type: 'A', name: 'home', target: '9.9.9.9', ttl_sec: 300 },
        ]),
      },
    ]);

    await expect(
      linodeProvider.update(linodeConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });

    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=A'),
        response: linodeRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/domains/42/records'),
        response: jsonResponse({
          data: { id: 202, type: 'A', name: 'home', target: '9.9.9.9', ttl_sec: 300 },
        }),
      },
    ]);

    await expect(
      linodeProvider.update(linodeConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('A home -> 9.9.9.9'),
    });
    expect(fetchMock.mock.calls.some(([, init = {}]) => (init.method ?? 'GET') === 'POST')).toBe(
      true,
    );
  });

  it('fails when record lookup is rejected', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=A'),
        response: jsonResponse({ errors: [{ reason: 'Unauthorized' }] }, 401),
      },
    ]);

    await expect(
      linodeProvider.update(linodeConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Linode record lookup failed (HTTP 401)'),
    });
  });

  it('writes an empty name for apex hosts', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=A'),
        response: linodeRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/domains/42/records'),
        response: jsonResponse({
          data: { id: 1, type: 'A', name: '', target: '9.9.9.9', ttl_sec: 300 },
        }),
      },
    ]);

    await linodeProvider.update(linodeConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
      v4: '9.9.9.9',
      v6: null,
    });

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'POST'),
    );
    expect(JSON.parse(post.body ?? '{}').name).toBe('');
  });

  it('matches and skips existing apex records stored with an empty name', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/records?type=A&name='),
        response: linodeRecords([{ id: 7, type: 'A', name: '', target: '9.9.9.9', ttl_sec: 300 }]),
      },
    ]);

    await expect(
      linodeProvider.update(linodeConfig({ hosts: ['example.com'], hostname: 'example.com' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });
    expect(getCall(fetchMock, 0).url.href).toContain('name=');
    expect(
      fetchMock.mock.calls.some(([, init = {}]) => ['POST', 'PUT'].includes(init.method ?? 'GET')),
    ).toBe(false);
  });

  it('updates A and AAAA independently', async () => {
    stubRoutedFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('type=AAAA'),
        response: linodeRecords([
          { id: 2, type: 'AAAA', name: 'home', target: '2001:db8::9', ttl_sec: 300 },
        ]),
      },
      {
        match: (url, method) => method === 'GET' && url.includes('type=A&'),
        response: linodeRecords([
          { id: 1, type: 'A', name: 'home', target: '1.1.1.1', ttl_sec: 300 },
        ]),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith('/records/1'),
        response: jsonResponse({
          data: { id: 1, type: 'A', name: 'home', target: '9.9.9.9', ttl_sec: 300 },
        }),
      },
    ]);

    const result = await linodeProvider.update(linodeConfig(), {
      v4: '9.9.9.9',
      v6: '2001:db8::9',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('A home -> 9.9.9.9');
    expect(result.message).toContain('AAAA home unchanged');
  });
});
