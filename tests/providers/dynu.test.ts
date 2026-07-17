import { describe, expect, it } from 'vite-plus/test';
import { afterEachResetFetch } from '../helpers/cleanup.js';

import { dynuProvider } from '../../lib/providers/dynu.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('dynu provider', () => {
  it('uses UDDNS_TOKEN as password fallback and sends ipv4/ipv6', async () => {
    const fetchMock = stubFetch(async () => textResponse('good 203.0.113.8'));

    const result = await dynuProvider.update(
      makeConfig({
        user: 'dynu-user',
        token: 'token-as-pass',
        hostname: 'home.dynu.com',
      }),
      { v4: '203.0.113.8', v6: '2001:db8::8' },
    );

    expect(result.ok).toBe(true);

    const call = getCall(fetchMock);
    expect(call.url.origin).toBe('https://api.dynu.com');
    expect(call.url.pathname).toBe('/nic/update');
    expect(call.url.searchParams.get('hostname')).toBe('home.dynu.com');
    expect(call.url.searchParams.get('myip')).toBe('203.0.113.8');
    expect(call.url.searchParams.get('myipv6')).toBe('2001:db8::8');
    expect(call.auth).toEqual({ user: 'dynu-user', pass: 'token-as-pass' });
  });

  it('prefers UDDNS_PASS over token and validates required fields', async () => {
    const fetchMock = stubFetch(async () => textResponse('nochg 1.1.1.1'));

    const result = await dynuProvider.update(
      makeConfig({
        user: 'dynu-user',
        password: 'real-pass',
        token: 'ignored-token',
        hostname: 'home.dynu.com',
      }),
      { v4: '1.1.1.1', v6: null },
    );

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(getCall(fetchMock).auth).toEqual({ user: 'dynu-user', pass: 'real-pass' });

    await expect(
      dynuProvider.update(makeConfig({ user: 'only-user' }), { v4: '1.1.1.1', v6: null }),
    ).resolves.toMatchObject({
      ok: false,
      details: expect.objectContaining({ hasUser: true, hasPassword: false }),
    });
  });
});
