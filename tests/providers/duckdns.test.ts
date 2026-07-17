import { describe, expect, it } from 'vite-plus/test';
import { afterEachResetFetch } from '../helpers/cleanup.js';

import { duckdnsProvider } from '../../lib/providers/duckdns.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('duckdns provider', () => {
  it('updates with token, strips .duckdns.org, and can send ipv6', async () => {
    const fetchMock = stubFetch(async () => textResponse('OK\n203.0.113.9'));

    const result = await duckdnsProvider.update(
      makeConfig({ duckdns: { domains: 'home.duckdns.org', token: 'duck-token' } }),
      { v4: '203.0.113.9', v6: '2001:db8::9' },
    );

    expect(result).toMatchObject({
      ok: true,
      message: 'OK\n203.0.113.9',
      details: expect.objectContaining({
        domains: 'home.duckdns.org',
        ipv4: '203.0.113.9',
        ipv6: '2001:db8::9',
        status: 200,
      }),
    });

    const call = getCall(fetchMock);
    expect(call.url.origin).toBe('https://www.duckdns.org');
    expect(call.url.pathname).toBe('/update');
    expect(call.url.searchParams.get('domains')).toBe('home');
    expect(call.url.searchParams.get('token')).toBe('duck-token');
    expect(call.url.searchParams.get('ip')).toBe('203.0.113.9');
    expect(call.url.searchParams.get('ipv6')).toBe('2001:db8::9');
    expect(call.url.searchParams.get('verbose')).toBe('true');
  });

  it('fails without contacting DuckDNS when no IPv4 is available', async () => {
    const fetchMock = stubFetch(async () => textResponse('OK'));

    await expect(
      duckdnsProvider.update(makeConfig({ duckdns: { domains: 'home', token: 'duck-token' } }), {
        v4: null,
        v6: '2001:db8::1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IPv4 available',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with actionable details when credentials or provider response are bad', async () => {
    await expect(
      duckdnsProvider.update(makeConfig({ duckdns: { domains: 'home', token: null } }), {
        v4: '1.1.1.1',
        v6: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('DUCKDNS_TOKEN'),
      details: { hasDomains: true, hasToken: false },
    });

    stubFetch(async () => textResponse('KO', 200));
    const ko = await duckdnsProvider.update(
      makeConfig({ duckdns: { domains: 'home', token: 'duck-token' } }),
      { v4: '1.1.1.1', v6: null },
    );

    expect(ko.ok).toBe(false);
    expect(ko.message).toContain('KO');
    expect(ko.details?.['hint']).toMatch(/DUCKDNS_TOKEN/i);
  });
});
