import { describe, expect, it } from 'vite-plus/test';
import { afterEachResetFetch } from '../helpers/cleanup.js';

import { namecheapProvider } from '../../lib/providers/namecheap.js';
import { makeConfig } from '../helpers/config.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('namecheap provider', () => {
  it('sends host/domain/password/ip and accepts ErrCount=0', async () => {
    const fetchMock = stubFetch(async () =>
      textResponse('<interface-response><ErrCount>0</ErrCount></interface-response>'),
    );

    const result = await namecheapProvider.update(
      makeConfig({
        namecheap: {
          host: 'home',
          domain: 'example.com',
          password: 'ddns-pass',
        },
      }),
      { v4: '203.0.113.20', v6: null },
    );

    expect(result).toMatchObject({
      ok: true,
      message: 'Updated home.example.com -> 203.0.113.20',
      details: expect.objectContaining({
        host: 'home',
        domain: 'example.com',
        fqdn: 'home.example.com',
        errCount: '0',
      }),
    });

    const call = getCall(fetchMock);
    expect(call.url.origin).toBe('https://dynamicdns.park-your-domain.com');
    expect(call.url.pathname).toBe('/update');
    expect(call.url.searchParams.get('host')).toBe('home');
    expect(call.url.searchParams.get('domain')).toBe('example.com');
    expect(call.url.searchParams.get('password')).toBe('ddns-pass');
    expect(call.url.searchParams.get('ip')).toBe('203.0.113.20');
  });

  it('fails without contacting Namecheap when no IPv4 is available', async () => {
    const fetchMock = stubFetch(async () => textResponse('irrelevant'));

    await expect(
      namecheapProvider.update(
        makeConfig({ namecheap: { host: 'home', domain: 'example.com', password: 'x' } }),
        { v4: null, v6: '2001:db8::1' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: 'No public IPv4 available',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses provider error XML and validates required config', async () => {
    stubFetch(async () =>
      textResponse(
        '<interface-response><ErrCount>1</ErrCount><Err1>Invalid password</Err1></interface-response>',
      ),
    );

    const failed = await namecheapProvider.update(
      makeConfig({
        namecheap: {
          host: 'home',
          domain: 'example.com',
          password: 'bad',
        },
      }),
      { v4: '1.2.3.4', v6: null },
    );

    expect(failed).toMatchObject({
      ok: false,
      message: 'Namecheap update failed: Invalid password',
      details: expect.objectContaining({
        errCount: '1',
        errorText: 'Invalid password',
        hint: expect.stringMatching(/Dynamic DNS password/i),
      }),
    });

    await expect(
      namecheapProvider.update(
        makeConfig({ namecheap: { host: 'home', domain: null, password: 'x' } }),
        { v4: '1.2.3.4', v6: null },
      ),
    ).resolves.toMatchObject({
      ok: false,
      details: expect.objectContaining({ hasDomain: false, hasPassword: true }),
    });
  });
});
