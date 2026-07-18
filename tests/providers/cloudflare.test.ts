import { describe, expect, it } from 'vite-plus/test';

import { cloudflareProvider } from '../../lib/providers/cloudflare.js';
import {
  cloudflareRecordResponseSchema,
  cloudflareZonesResponseSchema,
} from '../../lib/schemas/cloudflare.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import {
  cfErr,
  cfOk,
  cfRecords,
  cfZones,
  parseJsonBody,
  stubCloudflareFetch,
  stubCloudflareResponse,
} from '../helpers/cloudflare-fetch.js';
import { makeConfig } from '../helpers/config.js';
import { fetchInputUrl, getCall, jsonResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('cloudflare response schemas', () => {
  it('accepts envelope shapes built by the shared factory', () => {
    expect(
      cloudflareZonesResponseSchema.parse({
        success: true,
        result: [{ id: 'zone1', name: 'example.com' }],
      }).result,
    ).toEqual([{ id: 'zone1', name: 'example.com' }]);

    expect(
      cloudflareRecordResponseSchema.parse({
        success: true,
        result: null,
      }).result,
    ).toBeNull();
  });
});

describe('cloudflare provider', () => {
  it('requires token and record name before contacting the API', async () => {
    const fetchMock = stubCloudflareResponse(cfOk([]));

    await expect(
      cloudflareProvider.update(makeConfig({ cloudflare: { recordName: null } }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('CLOUDFLARE_API_TOKEN'),
      details: expect.objectContaining({ hint: expect.stringMatching(/Zone → DNS → Edit/) }),
    });

    await expect(
      cloudflareProvider.update(
        makeConfig({ cloudflare: { apiToken: 'token', recordName: null } }),
        { v4: '1.1.1.1', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/RECORD_NAME|UDDNS_HOST/),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the zone, patches an A record body, and sends a bearer token', async () => {
    const fetchMock = stubCloudflareFetch([
      {
        match: (url) => url.includes('/zones?') && url.includes('name=example.com'),
        response: cfZones([{ id: 'zone1', name: 'example.com' }]),
      },
      {
        match: (url) => url.includes('/dns_records?') && url.includes('type=A'),
        response: cfRecords([{ id: 'record1', content: '1.1.1.1', proxied: false }]),
      },
      {
        match: (url, method) => method === 'PATCH' && url.endsWith('/dns_records/record1'),
        response: cfOk({ id: 'record1', content: '9.9.9.9', proxied: false }),
      },
    ]);

    const result = await cloudflareProvider.update(
      makeConfig({
        cloudflare: {
          apiToken: 'cf-token',
          zoneName: 'example.com',
          recordName: 'home.example.com',
          proxied: true,
          ttl: 120,
        },
      }),
      { v4: '9.9.9.9', v6: null },
    );

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({ zoneId: 'zone1', recordName: 'home.example.com' }),
    });

    const patch = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([input, init = {}]) => {
        return (
          fetchInputUrl(input).endsWith('/dns_records/record1') &&
          (init.method ?? 'GET') === 'PATCH'
        );
      }),
    );

    expect(patch.headers.get('Authorization')).toBe('Bearer cf-token');
    expect(parseJsonBody(patch.body)).toEqual({
      type: 'A',
      name: 'home.example.com',
      content: '9.9.9.9',
      ttl: 120,
      proxied: true,
    });
  });

  it('skips unchanged records and creates missing ones when enabled', async () => {
    stubCloudflareFetch([
      {
        match: (url) => url.includes('/dns_records?'),
        response: cfRecords([{ id: 'record1', content: '9.9.9.9' }]),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });

    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/dns_records'),
        response: (_url, init = {}) => {
          expect(parseJsonBody(typeof init.body === 'string' ? init.body : null)).toMatchObject({
            type: 'A',
            name: 'home.example.com',
            content: '9.9.9.9',
          });
          return cfOk({ id: 'new1', content: '9.9.9.9', proxied: false });
        },
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            createIfMissing: true,
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com'),
    });
  });

  it('strips trailing dots from Cloudflare record and zone names', async () => {
    stubCloudflareFetch([
      {
        match: (url, method) => method === 'GET' && url.includes('/zones?name=example.com'),
        response: cfZones([{ id: 'zone1', name: 'example.com' }]),
      },
      {
        match: (url, method) =>
          method === 'GET' &&
          url.includes('/dns_records?') &&
          url.includes('name=home.example.com'),
        response: cfRecords([{ id: 'r1', content: '9.9.9.9' }]),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneName: 'example.com.',
            recordName: 'home.example.com.',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      details: expect.objectContaining({ recordName: 'home.example.com' }),
    });
  });

  it('patches a record when only its TTL changed', async () => {
    const fetchMock = stubCloudflareFetch([
      {
        match: (url) => url.includes('/dns_records?'),
        response: cfRecords([{ id: 'record1', content: '9.9.9.9', proxied: false, ttl: 120 }]),
      },
      {
        match: (_url, method) => method === 'PATCH',
        response: cfOk({ id: 'record1' }),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            ttl: 300,
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({ ok: true, message: expect.stringContaining('-> 9.9.9.9') });

    const patch = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(([, init = {}]) => (init.method ?? 'GET') === 'PATCH'),
    );
    expect(JSON.parse(patch.body ?? '{}')).toMatchObject({ ttl: 300 });
  });

  it('fails when createIfMissing is false or Cloudflare returns API errors', async () => {
    stubCloudflareResponse(cfRecords([]));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            createIfMissing: false,
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('not found'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              hint: expect.stringMatching(/CREATE_IF_MISSING/i),
            }),
          }),
        ],
      }),
    });

    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([{ id: 'record1', content: '1.1.1.1' }]),
      },
      {
        match: () => true,
        response: cfErr([{ code: 10000, message: 'Authentication error' }], 403),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'bad-token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Authentication error'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              errors: [{ code: 10000, message: 'Authentication error' }],
            }),
          }),
        ],
      }),
    });
  });

  it('fails fast when no public IP is available', async () => {
    const fetchMock = stubCloudflareResponse(cfRecords([]));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: null, v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IP available',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('walks record labels to discover the zone when zone id/name are unset', async () => {
    const zoneQueries: string[] = [];
    stubCloudflareFetch([
      {
        match: (url) => url.includes('/zones?'),
        response: (url) => {
          const name = new URL(url).searchParams.get('name') ?? '';
          zoneQueries.push(name);
          return cfZones(name === 'example.com' ? [{ id: 'zone1', name }] : []);
        },
      },
      {
        match: (url) => url.includes('/dns_records?'),
        response: cfRecords([{ id: 'record1', content: '1.1.1.1' }]),
      },
      {
        match: (url, method) => method === 'PATCH' && url.endsWith('/dns_records/record1'),
        response: cfOk({ id: 'record1', content: '9.9.9.9', proxied: false }),
      },
    ]);

    const result = await cloudflareProvider.update(
      makeConfig({
        cloudflare: { apiToken: 'token', recordName: 'home.lan.example.com' },
      }),
      { v4: '9.9.9.9', v6: null },
    );

    expect(result.ok).toBe(true);
    expect(zoneQueries).toEqual(['home.lan.example.com', 'lan.example.com', 'example.com']);
  });

  it('fails with guidance when no zone can be resolved', async () => {
    stubCloudflareResponse(cfZones([]));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Could not resolve Cloudflare zone'),
      details: expect.objectContaining({
        hint: expect.stringContaining('apex domain'),
      }),
    });
  });

  it('rejects success=false zone and pinned-record lookups', async () => {
    stubCloudflareResponse(cfErr([{ code: 9109, message: 'Invalid access token' }]));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'bad', zoneName: 'example.com', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/zone lookup.*Invalid access token/i);

    stubCloudflareResponse(cfErr([{ code: 9109, message: 'Invalid access token' }]));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'bad',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            recordId: 'pinned1',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/record lookup for pinned1.*Invalid access token/i);
  });

  it('reports patch and create failures even when the error body is bare', async () => {
    // PATCH failure: HTTP 200 with success=false and no errors array.
    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([{ id: 'record1', content: '1.1.1.1' }]),
      },
      {
        match: () => true,
        response: jsonResponse({ success: false }),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/Cloudflare API request failed/),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({ action: 'patch', errors: null }),
          }),
        ],
      }),
    });

    // Create failure: record missing, POST rejected.
    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([]),
      },
      {
        match: () => true,
        response: cfErr([{ code: 81057, message: 'Record already exists' }], 400),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            createIfMissing: true,
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Record already exists'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({
            details: expect.objectContaining({ action: 'create' }),
          }),
        ],
      }),
    });
  });

  it('rejects success=false lookup envelopes instead of treating them as missing', async () => {
    const fetchMock = stubCloudflareResponse(
      cfErr([{ code: 10000, message: 'Authentication error' }], 403),
    );

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'bad', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/record lookup.*Authentication error/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fetches the pinned record by id for A and updates AAAA independently', async () => {
    const fetchMock = stubCloudflareFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dns_records/pinned1'),
        response: cfOk({ id: 'pinned1', content: '1.1.1.1', proxied: false }),
      },
      {
        match: (url, method) => method === 'PATCH' && url.endsWith('/dns_records/pinned1'),
        response: cfOk({ id: 'pinned1', content: '9.9.9.9', proxied: false }),
      },
      {
        match: (url) => url.includes('/dns_records?') && url.includes('type=AAAA'),
        response: cfRecords([]),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/dns_records'),
        response: cfOk({ id: 'new-aaaa', content: '2001:db8::9', proxied: false }),
      },
    ]);

    const result = await cloudflareProvider.update(
      makeConfig({
        cloudflare: {
          apiToken: 'token',
          zoneId: 'zone1',
          recordName: 'home.example.com',
          recordId: 'pinned1',
          createIfMissing: true,
        },
      }),
      { v4: '9.9.9.9', v6: '2001:db8::9' },
    );

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
    });
    expect(result.message).toContain('Created AAAA home.example.com -> 2001:db8::9');

    const post = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(
        ([input, init = {}]) =>
          fetchInputUrl(input).endsWith('/dns_records') && (init.method ?? 'GET') === 'POST',
      ),
    );
    expect(JSON.parse(post.body ?? '{}')).toMatchObject({
      type: 'AAAA',
      content: '2001:db8::9',
    });
  });

  it('falls back to name lookup when pinned record hostname mismatches', async () => {
    const fetchMock = stubCloudflareFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dns_records/wrong-pin'),
        response: cfOk({
          id: 'wrong-pin',
          type: 'A',
          name: 'other.example.com',
          content: '1.1.1.1',
          proxied: false,
        }),
      },
      {
        match: (url) => url.includes('/dns_records?') && url.includes('type=A'),
        response: cfRecords([
          {
            id: 'correct',
            type: 'A',
            name: 'home.example.com',
            content: '1.1.1.1',
            proxied: false,
          },
        ]),
      },
      {
        match: (url, method) => method === 'PATCH' && url.endsWith('/dns_records/correct'),
        response: cfOk({
          id: 'correct',
          type: 'A',
          name: 'home.example.com',
          content: '9.9.9.9',
          proxied: false,
        }),
      },
    ]);

    const result = await cloudflareProvider.update(
      makeConfig({
        cloudflare: {
          apiToken: 'token',
          zoneId: 'zone1',
          recordName: 'home.example.com',
          recordId: 'wrong-pin',
          createIfMissing: false,
        },
      }),
      { v4: '9.9.9.9', v6: null },
    );

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
    });
    expect(
      fetchMock.mock.calls.some(([input, init = {}]) => {
        const url = fetchInputUrl(input);
        return url.endsWith('/dns_records/wrong-pin') && (init.method ?? 'GET') === 'PATCH';
      }),
    ).toBe(false);
    const patch = getCall(
      fetchMock,
      fetchMock.mock.calls.findIndex(
        ([input, init = {}]) =>
          fetchInputUrl(input).endsWith('/dns_records/correct') &&
          (init.method ?? 'GET') === 'PATCH',
      ),
    );
    expect(JSON.parse(patch.body ?? '{}')).toMatchObject({
      type: 'A',
      name: 'home.example.com',
      content: '9.9.9.9',
    });
  });

  it('treats a null pinned-record lookup as missing and creates the record', async () => {
    stubCloudflareFetch([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/dns_records/gone1'),
        response: cfOk(null),
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/dns_records'),
        response: cfOk({ id: 'new1', content: '9.9.9.9', proxied: false }),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            recordId: 'gone1',
            createIfMissing: true,
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com'),
    });
  });

  it('synthesizes an error from the HTTP status when the failure body has no errors', async () => {
    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([{ id: 'record1', content: '1.1.1.1' }]),
      },
      {
        match: () => true,
        // 502 with an empty JSON envelope: no success flag, no errors array.
        response: jsonResponse({}, 502),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('HTTP 502'),
    });
  });

  it('falls back to request metadata when success=false carries no error detail', async () => {
    stubCloudflareFetch([
      {
        match: (url, method) => url.includes('/dns_records?') && method === 'GET',
        response: cfRecords([{ id: 'record1', content: '1.1.1.1' }]),
      },
      {
        match: () => true,
        // HTTP 200 but success=false, with an errors entry that has no message.
        response: cfErr([{ code: 9999 }], 200),
      },
    ]);

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/Cloudflare API request failed \(HTTP 200/),
    });
  });

  it('throws a descriptive error on non-JSON responses', async () => {
    stubCloudflareResponse(new Response('<html>gateway timeout</html>', { status: 504 }));

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/non-JSON \(504/);
  });

  it('rejects malformed Cloudflare API response shapes', async () => {
    stubCloudflareResponse(
      jsonResponse({
        success: true,
        result: [{ id: 123, name: 'example.com' }],
      }),
    );

    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneName: 'example.com',
            recordName: 'home.example.com',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/zones response failed validation/i);

    // Record list with a malformed record entry.
    stubCloudflareResponse(
      jsonResponse({ success: true, result: [{ id: 'r1', content: 42, proxied: 'no' }] }),
    );
    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/records response failed validation/i);

    // Pinned-record lookup with a malformed record body.
    stubCloudflareResponse(jsonResponse({ success: true, result: { id: 'r1' } }));
    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: {
            apiToken: 'token',
            zoneId: 'zone1',
            recordName: 'home.example.com',
            recordId: 'r1',
          },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/record response failed validation/i);

    // Envelope that is valid JSON but not an object.
    stubCloudflareResponse(jsonResponse([1, 2, 3]));
    await expect(
      cloudflareProvider.update(
        makeConfig({
          cloudflare: { apiToken: 'token', zoneId: 'zone1', recordName: 'home.example.com' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).rejects.toThrow(/invalid JSON/i);
  });
});
