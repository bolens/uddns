import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { cloudflareProvider } from '../../lib/providers/cloudflare.js';
import { makeConfig } from '../helpers/config.js';
import { fetchInputUrl, getCall, jsonResponse, stubFetch } from '../helpers/fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloudflare provider', () => {
  it('requires token and record name before contacting the API', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ success: true, result: [] }));

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
      message: expect.stringMatching(/RECORD_NAME|DDNS_HOST/),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the zone, patches an A record body, and sends a bearer token', async () => {
    const fetchMock = stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';

      if (url.includes('/zones?') && url.includes('name=example.com')) {
        return jsonResponse({ success: true, result: [{ id: 'zone1', name: 'example.com' }] });
      }

      if (url.includes('/dns_records?') && url.includes('type=A')) {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '1.1.1.1', proxied: false }],
        });
      }

      if (method === 'PATCH' && url.endsWith('/dns_records/record1')) {
        return jsonResponse({
          success: true,
          result: { id: 'record1', content: '9.9.9.9', proxied: false },
        });
      }

      return jsonResponse(
        { success: false, errors: [{ message: `unexpected ${method} ${url}` }] },
        500,
      );
    });

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
    expect(JSON.parse(patch.body ?? '{}')).toEqual({
      type: 'A',
      name: 'home.example.com',
      content: '9.9.9.9',
      ttl: 120,
      proxied: true,
    });
  });

  it('skips unchanged records and creates missing ones when enabled', async () => {
    stubFetch(async (input) => {
      const url = fetchInputUrl(input);
      if (url.includes('/dns_records?')) {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '9.9.9.9', proxied: false }],
        });
      }
      return jsonResponse({ success: false, errors: [{ message: `unexpected ${url}` }] }, 500);
    });

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

    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';
      if (url.includes('/dns_records?') && method === 'GET') {
        return jsonResponse({ success: true, result: [] });
      }
      if (method === 'POST' && url.endsWith('/dns_records')) {
        expect(typeof init.body).toBe('string');
        expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toMatchObject({
          type: 'A',
          name: 'home.example.com',
          content: '9.9.9.9',
        });
        return jsonResponse({
          success: true,
          result: { id: 'new1', content: '9.9.9.9', proxied: false },
        });
      }
      return jsonResponse(
        { success: false, errors: [{ message: `unexpected ${method} ${url}` }] },
        500,
      );
    });

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

  it('fails when createIfMissing is false or Cloudflare returns API errors', async () => {
    stubFetch(async () => jsonResponse({ success: true, result: [] }));

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

    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';
      if (url.includes('/dns_records?') && method === 'GET') {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '1.1.1.1', proxied: false }],
        });
      }
      return jsonResponse(
        {
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
        },
        403,
      );
    });

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
    const fetchMock = stubFetch(async () => jsonResponse({ success: true, result: [] }));

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
    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';

      if (url.includes('/zones?')) {
        const name = new URL(url).searchParams.get('name') ?? '';
        zoneQueries.push(name);
        if (name === 'example.com') {
          return jsonResponse({ success: true, result: [{ id: 'zone1', name }] });
        }
        return jsonResponse({ success: true, result: [] });
      }

      if (url.includes('/dns_records?')) {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '1.1.1.1', proxied: false }],
        });
      }

      if (method === 'PATCH' && url.endsWith('/dns_records/record1')) {
        return jsonResponse({
          success: true,
          result: { id: 'record1', content: '9.9.9.9', proxied: false },
        });
      }

      return jsonResponse({ success: false, errors: [{ message: `unexpected ${url}` }] }, 500);
    });

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
    stubFetch(async () => jsonResponse({ success: true, result: [] }));

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

  it('fetches the pinned record by id for A and updates AAAA independently', async () => {
    const fetchMock = stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';

      if (method === 'GET' && url.endsWith('/dns_records/pinned1')) {
        return jsonResponse({
          success: true,
          result: { id: 'pinned1', content: '1.1.1.1', proxied: false },
        });
      }

      if (method === 'PATCH' && url.endsWith('/dns_records/pinned1')) {
        return jsonResponse({
          success: true,
          result: { id: 'pinned1', content: '9.9.9.9', proxied: false },
        });
      }

      if (url.includes('/dns_records?') && url.includes('type=AAAA')) {
        return jsonResponse({ success: true, result: [] });
      }

      if (method === 'POST' && url.endsWith('/dns_records')) {
        return jsonResponse({
          success: true,
          result: { id: 'new-aaaa', content: '2001:db8::9', proxied: false },
        });
      }

      return jsonResponse(
        { success: false, errors: [{ message: `unexpected ${method} ${url}` }] },
        500,
      );
    });

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

  it('treats a null pinned-record lookup as missing and creates the record', async () => {
    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';

      if (method === 'GET' && url.endsWith('/dns_records/gone1')) {
        return jsonResponse({ success: true, result: null });
      }

      if (method === 'POST' && url.endsWith('/dns_records')) {
        return jsonResponse({
          success: true,
          result: { id: 'new1', content: '9.9.9.9', proxied: false },
        });
      }

      return jsonResponse(
        { success: false, errors: [{ message: `unexpected ${method} ${url}` }] },
        500,
      );
    });

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
    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';
      if (url.includes('/dns_records?') && method === 'GET') {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '1.1.1.1', proxied: false }],
        });
      }
      // 502 with an empty JSON envelope: no success flag, no errors array.
      return jsonResponse({}, 502);
    });

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
    stubFetch(async (input, init = {}) => {
      const url = fetchInputUrl(input);
      const method = init.method ?? 'GET';
      if (url.includes('/dns_records?') && method === 'GET') {
        return jsonResponse({
          success: true,
          result: [{ id: 'record1', content: '1.1.1.1', proxied: false }],
        });
      }
      // HTTP 200 but success=false, with an errors entry that has no message.
      return jsonResponse({ success: false, errors: [{ code: 9999 }] });
    });

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
    stubFetch(async () => new Response('<html>gateway timeout</html>', { status: 504 }));

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
    stubFetch(async () =>
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
    stubFetch(async () =>
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
    stubFetch(async () => jsonResponse({ success: true, result: { id: 'r1' } }));
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
    stubFetch(async () => jsonResponse([1, 2, 3]));
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
