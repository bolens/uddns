import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { HttpError, request, sanitizeUrl, truncateBody, userAgent } from '../lib/providers/http.js';
import { getCall } from './helpers/fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sanitizeUrl', () => {
  it('redacts userinfo and sensitive query params while keeping hostname', () => {
    expect(sanitizeUrl('https://user:pass@example.com/nic/update?token=abc&hostname=x')).toBe(
      'https://***:***@example.com/nic/update?token=%5Bredacted%5D&hostname=x',
    );
    expect(sanitizeUrl('https://example.com/path?password=x&keep=1')).toContain(
      'password=%5Bredacted%5D',
    );
    expect(sanitizeUrl('https://example.com/path?password=x&keep=1')).toContain('keep=1');
  });

  it('masks userinfo in unparseable URLs via the fallback', () => {
    expect(sanitizeUrl('not a url //user:pass@host/path')).toBe('not a url //***@host/path');
  });
});

describe('truncateBody', () => {
  it('keeps short bodies and truncates long ones with a remainder marker', () => {
    expect(truncateBody('ok')).toBe('ok');
    expect(truncateBody('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}…(+10 chars)`);
  });
});

describe('request', () => {
  it('sets a User-Agent, returns timing metadata, and sanitizes logged URLs', async () => {
    const fetchMock = vi.fn(
      async () => new Response('hello', { status: 201, statusText: 'Created' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ok = await request('https://example.com/update?token=super-secret', {
      method: 'POST',
      headers: { Authorization: 'Bearer abc' },
    });

    expect(ok.body).toBe('hello');
    expect(ok.meta).toMatchObject({
      method: 'POST',
      status: 201,
      statusText: 'Created',
      bodyPreview: 'hello',
      url: 'https://example.com/update?token=%5Bredacted%5D',
    });
    expect(ok.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(ok.meta.url).not.toContain('super-secret');

    const call = getCall(fetchMock);
    expect(call.headers.get('User-Agent')).toBe(userAgent);
    expect(call.headers.get('Authorization')).toBe('Bearer abc');
  });

  it('wraps network failures with method, sanitized URL, timing, and cause code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('dns'), {
          code: 'ENOTFOUND',
          errno: -3008,
          syscall: 'getaddrinfo',
          hostname: 'missing.example',
        });
      }),
    );

    await expect(request('https://user:pass@missing.example/path?token=abc')).rejects.toMatchObject(
      {
        message: expect.stringMatching(/HTTP GET https:\/\/\*\*\*:\*\*\*@missing\.example\/path/),
        cause: expect.objectContaining({ message: 'dns' }),
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'missing.example',
      },
    );

    await expect(
      request('https://user:pass@missing.example/path?token=abc'),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it('wraps non-Error throwables without network fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'socket exploded';
      }),
    );

    await expect(request('https://example.com/x')).rejects.toMatchObject({
      name: 'HttpError',
      message: expect.stringContaining('socket exploded'),
    });
  });
});
