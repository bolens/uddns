import { describe, expect, it } from 'vite-plus/test';

import { getQuery, ipDetails } from '../../lib/providers/query.js';
import { afterEachResetFetch } from '../helpers/cleanup.js';
import { getCall, stubFetch, textResponse } from '../helpers/fetch.js';

afterEachResetFetch();

describe('getQuery', () => {
  it('builds a GET URL from params and returns the trimmed body', async () => {
    const fetchMock = stubFetch(async () => textResponse('  OK  '));

    const result = await getQuery('https://example.com/update', {
      hostname: 'home.example.com',
      myip: '1.2.3.4',
    });

    expect(result.text).toBe('OK');
    expect(result.body).toBe('  OK  ');
    expect(result.response.status).toBe(200);

    const call = getCall(fetchMock);
    expect(call.method).toBe('GET');
    expect(call.url.href).toBe('https://example.com/update?hostname=home.example.com&myip=1.2.3.4');
  });

  it('forwards request init headers', async () => {
    const fetchMock = stubFetch(async () => textResponse('good'));

    await getQuery(
      'https://example.com/nic/update',
      { hostname: 'x' },
      { headers: { Authorization: 'Basic abc' } },
    );

    expect(getCall(fetchMock).headers.get('Authorization')).toBe('Basic abc');
  });
});

describe('ipDetails', () => {
  it('merges IP, extras, and request metadata', () => {
    expect(
      ipDetails(
        { v4: '1.2.3.4', v6: '2001:db8::1' },
        {
          method: 'GET',
          url: 'https://example.com',
          status: 200,
          statusText: 'OK',
          durationMs: 12,
          bodyPreview: 'ok',
        },
        { hostname: 'home.example.com' },
      ),
    ).toEqual({
      hostname: 'home.example.com',
      ipv4: '1.2.3.4',
      ipv6: '2001:db8::1',
      method: 'GET',
      url: 'https://example.com',
      status: 200,
      statusText: 'OK',
      durationMs: 12,
      bodyPreview: 'ok',
    });
  });
});
