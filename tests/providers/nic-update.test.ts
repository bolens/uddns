import { describe, expect, it } from 'vite-plus/test';
import { afterEachResetFetch } from '../helpers/cleanup.js';

import { interpretNicUpdateBody, updateNicDns } from '../../lib/providers/nic-update.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('interpretNicUpdateBody', () => {
  it('maps good/nochg and known failure codes with hints', () => {
    expect(interpretNicUpdateBody('good 1.2.3.4', 200)).toMatchObject({
      ok: true,
      message: 'good 1.2.3.4',
      details: expect.objectContaining({ response: 'good 1.2.3.4', httpStatus: 200 }),
    });

    expect(interpretNicUpdateBody('nochg 1.2.3.4', 200)).toMatchObject({
      ok: true,
      skipped: true,
      message: 'nochg 1.2.3.4',
    });

    const cases: Array<[string, RegExp]> = [
      ['badauth', /Authentication failed/i],
      ['nohost', /not found/i],
      ['abuse', /abuse|frequent/i],
      ['911', /server error|retry/i],
    ];
    for (const [code, hint] of cases) {
      expect(interpretNicUpdateBody(code, 200)).toMatchObject({
        ok: false,
        message: expect.stringContaining(code),
        details: expect.objectContaining({ hint: expect.stringMatching(hint) }),
      });
    }

    expect(interpretNicUpdateBody('911', 200)).toMatchObject({
      ok: false,
      details: expect.objectContaining({ retryable: true, httpStatus: 503 }),
    });
    expect(interpretNicUpdateBody('dnserr', 200)).toMatchObject({
      ok: false,
      details: expect.objectContaining({ retryable: true, httpStatus: 503 }),
    });
  });

  it('falls back to the HTTP status for empty bodies and fails without a hint', () => {
    expect(interpretNicUpdateBody('', 500)).toMatchObject({
      ok: false,
      message: 'HTTP 500',
      details: expect.objectContaining({ httpStatus: 500, response: '' }),
    });

    const unknown = interpretNicUpdateBody('weird-response', 200);
    expect(unknown).toMatchObject({ ok: false, message: 'weird-response' });
    expect(unknown.details?.['hint']).toBeUndefined();
  });

  it('does not treat "good" as success on non-2xx statuses', () => {
    expect(interpretNicUpdateBody('good 1.2.3.4', 500)).toMatchObject({ ok: false });
  });

  it('does not treat "nochg" as success on non-2xx statuses', () => {
    expect(interpretNicUpdateBody('nochg 1.2.3.4', 401)).toMatchObject({ ok: false });
    expect(interpretNicUpdateBody('nochg 1.2.3.4', 500)).toMatchObject({ ok: false });
  });
});

describe('updateNicDns', () => {
  it('sends hostname/myip/myipv6 with basic auth and request metadata', async () => {
    const fetchMock = stubFetch(async () => textResponse('good 9.9.9.9'));

    const result = await updateNicDns({
      updateUrl: 'https://example.test/nic/update',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
      ip: { v4: '9.9.9.9', v6: '2001:db8::1' },
    });

    expect(result).toMatchObject({
      ok: true,
      details: expect.objectContaining({
        hostname: 'home.example.com',
        ipv4: '9.9.9.9',
        ipv6: '2001:db8::1',
        method: 'GET',
        status: 200,
        url: expect.stringContaining('https://example.test/nic/update'),
      }),
    });

    const call = getCall(fetchMock);
    expect(call.url.searchParams.get('hostname')).toBe('home.example.com');
    expect(call.url.searchParams.get('myip')).toBe('9.9.9.9');
    expect(call.url.searchParams.get('myipv6')).toBe('2001:db8::1');
    expect(call.auth).toEqual({ user: 'user', pass: 'pass' });
  });

  it('fails without ipv4 and does not call fetch', async () => {
    const fetchMock = stubFetch(async () => textResponse('good'));

    const result = await updateNicDns({
      updateUrl: 'https://example.test/nic/update',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
      ip: { v4: null, v6: '::1' },
    });

    expect(result).toMatchObject({
      ok: false,
      message: 'No public IPv4 available',
      details: expect.objectContaining({ hostname: 'home.example.com' }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes credentials embedded in the update URL before logging it', async () => {
    stubFetch(async () => textResponse('good'));

    const result = await updateNicDns({
      updateUrl: 'https://user:hunter2@example.test/nic/update?token=abc',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
      ip: { v4: null, v6: null },
    });

    expect(result.ok).toBe(false);
    expect(result.details?.['updateUrl']).toBe(
      'https://***:***@example.test/nic/update?token=%5Bredacted%5D',
    );
    expect(JSON.stringify(result.details)).not.toContain('hunter2');
  });
});
