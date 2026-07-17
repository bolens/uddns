import { describe, expect, it, vi } from 'vite-plus/test';
import { afterEachResetFetch } from './helpers/cleanup.js';

import { HttpError, request, sanitizeUrl, truncateBody, userAgent } from '../lib/providers/http.js';
import { getCall } from './helpers/fetch.js';

afterEachResetFetch();

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

  it('always passes an abort signal to fetch so requests cannot hang forever', async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await request('https://example.com/update');

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('aborts the request when the timeout elapses', async () => {
    const fetchMock = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('https://slow.example/update', { timeoutMs: 5 })).rejects.toMatchObject({
      name: 'HttpError',
      message: expect.stringMatching(/HTTP GET https:\/\/slow\.example\/update failed/),
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
  });

  it('combines a caller-provided signal with the timeout signal', async () => {
    const fetchMock = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const pending = request('https://example.com/update', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toMatchObject({
      name: 'HttpError',
      message: expect.stringContaining('caller cancelled'),
    });
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
