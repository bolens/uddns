import { describe, expect, it } from 'vite-plus/test';

import { porkbunProvider } from '../../lib/providers/porkbun.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, jsonResponse, stubRoutedFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

type PorkbunRecordFixture = {
  id: string;
  name: string;
  type: string;
  content: string;
};

function pbSuccess(records?: PorkbunRecordFixture[]): Response {
  return jsonResponse({
    status: 'SUCCESS',
    ...(records === undefined ? {} : { records }),
  });
}

function pbError(message: string, status = 400): Response {
  return jsonResponse({ status: 'ERROR', message }, status);
}

function pbConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    ...overrides,
    porkbun: {
      apiKey: 'pk1_key',
      secretKey: 'sk1_secret',
      domain: 'example.com',
      ...overrides.porkbun,
    },
  });
}

describe('porkbun provider', () => {
  it('requires API keys and a host before contacting the API', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      porkbunProvider.update(makeConfig({ porkbun: { apiKey: 'pk' } }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('PORKBUN_SECRET_KEY'),
      details: expect.objectContaining({ hasApiKey: true, hasSecretKey: false }),
    });

    await expect(
      porkbunProvider.update(pbConfig({ hosts: [], hostname: null }), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('UDDNS_HOST'),
    });

    await expect(porkbunProvider.update(pbConfig(), { v4: null, v6: null })).resolves.toMatchObject(
      {
        ok: false,
        message: 'No public IP available',
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('edits an existing A record and sends credentials in the JSON body', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/example.com/A/home'),
        response: pbSuccess([
          { id: '101', name: 'home.example.com', type: 'A', content: '1.1.1.1' },
        ]),
      },
      {
        match: (url) => url.includes('/dns/editByNameType/example.com/A/home'),
        response: pbSuccess(),
      },
    ]);

    const result = await porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null });

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining('A home.example.com -> 9.9.9.9'),
      details: expect.objectContaining({
        domain: 'example.com',
        subdomain: 'home',
        results: [
          expect.objectContaining({
            details: expect.objectContaining({
              action: 'edit',
              previous: '1.1.1.1',
              recordId: '101',
            }),
          }),
        ],
      }),
    });

    const retrieve = getCall(fetchMock, 0);
    expect(retrieve.method).toBe('POST');
    expect(JSON.parse(retrieve.body ?? '{}')).toEqual({
      apikey: 'pk1_key',
      secretapikey: 'sk1_secret',
    });

    const edit = getCall(fetchMock, 1);
    expect(JSON.parse(edit.body ?? '{}')).toEqual({
      apikey: 'pk1_key',
      secretapikey: 'sk1_secret',
      content: '9.9.9.9',
    });
  });

  it('skips unchanged records', async () => {
    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: pbSuccess([
          { id: '101', name: 'home.example.com', type: 'A', content: '9.9.9.9' },
        ]),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      skipped: true,
      message: expect.stringContaining('unchanged'),
    });
  });

  it('creates missing records with the bare subdomain as the name', async () => {
    const fetchMock = stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: pbSuccess([]),
      },
      {
        match: (url) => url.endsWith('/dns/create/example.com'),
        response: pbSuccess(),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A home.example.com -> 9.9.9.9'),
    });

    const create = getCall(fetchMock, 1);
    expect(JSON.parse(create.body ?? '{}')).toEqual({
      apikey: 'pk1_key',
      secretapikey: 'sk1_secret',
      name: 'home',
      type: 'A',
      content: '9.9.9.9',
    });
  });

  it('handles apex records and updates AAAA independently', async () => {
    const retrieveUrls: string[] = [];
    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: (url) => {
          retrieveUrls.push(url);
          return url.endsWith('/A')
            ? pbSuccess([{ id: '1', name: 'example.com', type: 'A', content: '1.1.1.1' }])
            : pbSuccess([]);
        },
      },
      {
        match: (url) => url.includes('/dns/editByNameType/example.com/A'),
        response: pbSuccess(),
      },
      {
        match: (url) => url.endsWith('/dns/create/example.com'),
        response: pbSuccess(),
      },
    ]);

    const result = await porkbunProvider.update(
      pbConfig({ hosts: ['example.com'], hostname: 'example.com' }),
      { v4: '9.9.9.9', v6: '2001:db8::9' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('A example.com -> 9.9.9.9');
    expect(result.message).toContain('Created AAAA example.com -> 2001:db8::9');
    // Apex records use the domain-only endpoint (no trailing subdomain segment).
    expect(retrieveUrls).toEqual([
      expect.stringMatching(/\/dns\/retrieveByNameType\/example\.com\/A$/),
      expect.stringMatching(/\/dns\/retrieveByNameType\/example\.com\/AAAA$/),
    ]);
  });

  it('derives the domain from an FQDN and accepts bare labels under PORKBUN_DOMAIN', async () => {
    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/example.com/A/vpn.home'),
        response: pbSuccess([]),
      },
      {
        match: (url) => url.endsWith('/dns/create/example.com'),
        response: pbSuccess(),
      },
    ]);

    await expect(
      porkbunProvider.update(
        makeConfig({
          hosts: ['vpn.home.example.com'],
          porkbun: { apiKey: 'pk', secretKey: 'sk' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Created A vpn.home.example.com'),
    });

    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/example.com/A/home'),
        response: pbSuccess([{ id: '1', name: 'home.example.com', type: 'A', content: '9.9.9.9' }]),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig({ hosts: ['home'], hostname: 'home' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({ ok: true, skipped: true });
  });

  it('fails with guidance when the domain cannot be determined', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      porkbunProvider.update(
        makeConfig({
          hosts: ['home'],
          hostname: 'home',
          porkbun: { apiKey: 'pk', secretKey: 'sk' },
        }),
        { v4: '9.9.9.9', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Set PORKBUN_DOMAIN'),
      details: expect.objectContaining({ hint: expect.stringContaining('PORKBUN_DOMAIN') }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects foreign FQDNs when PORKBUN_DOMAIN is set', async () => {
    const fetchMock = stubRoutedFetch([]);

    await expect(
      porkbunProvider.update(pbConfig({ hosts: ['other.net'], hostname: 'other.net' }), {
        v4: '9.9.9.9',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('outside PORKBUN_DOMAIN'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips trailing dots from hosts under PORKBUN_DOMAIN', async () => {
    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/example.com/A/home'),
        response: pbSuccess([{ id: '1', name: 'home.example.com', type: 'A', content: '9.9.9.9' }]),
      },
    ]);

    await expect(
      porkbunProvider.update(
        pbConfig({ hosts: ['home.example.com.'], hostname: 'home.example.com.' }),
        {
          v4: '9.9.9.9',
          v6: null,
        },
      ),
    ).resolves.toMatchObject({ ok: true, skipped: true });
  });

  it('surfaces Porkbun API errors from lookup, edit, and create', async () => {
    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: pbError('Invalid API key. (002)', 400),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Invalid API key. (002)'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'lookup' }) }),
        ],
      }),
    });

    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: pbSuccess([
          { id: '101', name: 'home.example.com', type: 'A', content: '1.1.1.1' },
        ]),
      },
      {
        match: (url) => url.includes('/dns/editByNameType/'),
        response: pbError('Edit error: no updates', 400),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Edit error: no updates'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'edit' }) }),
        ],
      }),
    });

    stubRoutedFetch([
      {
        match: (url) => url.includes('/dns/retrieveByNameType/'),
        response: pbSuccess([]),
      },
      {
        match: (url) => url.includes('/dns/create/'),
        response: jsonResponse({ status: 'ERROR' }, 503),
      },
    ]);

    await expect(
      porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('create for home.example.com failed (HTTP 503'),
      details: expect.objectContaining({
        results: [
          expect.objectContaining({ details: expect.objectContaining({ action: 'create' }) }),
        ],
      }),
    });
  });

  it('throws descriptive errors on non-JSON and malformed responses', async () => {
    stubRoutedFetch([
      {
        match: () => true,
        response: textResponse('<html>gateway timeout</html>', 504),
      },
    ]);

    await expect(porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /non-JSON \(504/,
    );

    stubRoutedFetch([
      {
        match: () => true,
        response: jsonResponse({ records: [] }),
      },
    ]);

    await expect(porkbunProvider.update(pbConfig(), { v4: '9.9.9.9', v6: null })).rejects.toThrow(
      /invalid JSON/i,
    );
  });
});
