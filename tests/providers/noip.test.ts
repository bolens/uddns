import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { noipProvider } from '../../lib/providers/noip.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('noip provider', () => {
  it('posts hostname/myip to No-IP with basic auth', async () => {
    const fetchMock = stubFetch(async () => textResponse('good 203.0.113.5'));

    const result = await noipProvider.update(
      makeConfig({
        user: 'noip-user',
        password: 'noip-pass',
        hostname: 'home.ddns.net',
      }),
      { v4: '203.0.113.5', v6: null },
    );

    expect(result).toMatchObject({
      ok: true,
      message: 'good 203.0.113.5',
      details: expect.objectContaining({
        hostname: 'home.ddns.net',
        ipv4: '203.0.113.5',
      }),
    });

    const call = getCall(fetchMock);
    expect(call.url.origin).toBe('https://dynupdate.no-ip.com');
    expect(call.url.pathname).toBe('/nic/update');
    expect(call.url.searchParams.get('hostname')).toBe('home.ddns.net');
    expect(call.url.searchParams.get('myip')).toBe('203.0.113.5');
    expect(call.auth).toEqual({ user: 'noip-user', pass: 'noip-pass' });
  });

  it('fails closed on missing credentials and provider auth errors', async () => {
    await expect(
      noipProvider.update(makeConfig({ hostname: 'home.ddns.net' }), {
        v4: '1.2.3.4',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('DDNS_USER'),
      details: { hasUser: false, hasPassword: false, hostname: 'home.ddns.net' },
    });

    stubFetch(async () => textResponse('badauth'));
    const authFail = await noipProvider.update(
      makeConfig({
        user: 'noip-user',
        password: 'bad',
        hostname: 'home.ddns.net',
      }),
      { v4: '1.2.3.4', v6: null },
    );

    expect(authFail.ok).toBe(false);
    expect(authFail.message).toContain('badauth');
    expect(authFail.details?.['hint']).toMatch(/Authentication failed/i);
  });
});
