import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { pinnedHttpsFetch } from '../lib/safe-https.js';
import { resolveSafeAddresses } from '../lib/url-policy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type MockReq = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

type MockAgentInstance = {
  destroy: ReturnType<typeof vi.fn>;
  lookup?: https.AgentOptions['lookup'];
};

function createMockReq(): MockReq {
  const req = new EventEmitter() as MockReq;
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn((error?: Error) => {
    if (error) {
      req.emit('error', error);
    }
  });
  return req;
}

function installHttpsMocks(handler: {
  statusCode?: number;
  headers?: IncomingMessage['headers'];
  body?: Buffer | string;
  onRequest?: (options: https.RequestOptions, agent: MockAgentInstance, req: MockReq) => void;
  respond?: boolean;
}): { agents: MockAgentInstance[]; reqs: MockReq[] } {
  const agents: MockAgentInstance[] = [];
  const reqs: MockReq[] = [];

  function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
    this.destroy = vi.fn();
    this.lookup = options?.lookup;
    agents.push(this);
  }

  vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);

  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback?: (res: IncomingMessage) => void,
  ) => {
    const req = createMockReq();
    reqs.push(req);
    const agent = (options.agent as MockAgentInstance | undefined) ?? agents[agents.length - 1]!;
    handler.onRequest?.(options, agent, req);

    if (handler.respond !== false) {
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        Object.defineProperty(res, 'statusCode', {
          value: handler.statusCode ?? 200,
        });
        Object.defineProperty(res, 'headers', {
          value: handler.headers ?? { 'content-type': 'text/plain' },
        });
        callback?.(res);
        const body = Buffer.isBuffer(handler.body)
          ? handler.body
          : Buffer.from(handler.body ?? 'ok');
        if (body.length > 0) {
          res.emit('data', body);
        }
        res.emit('end');
      });
    }
    return req as unknown as ReturnType<typeof https.request>;
  }) as unknown as typeof https.request);

  return { agents, reqs };
}

describe('resolveSafeAddresses', () => {
  it('returns IP literals that are allowed', async () => {
    const url = new URL('https://1.1.1.1/');
    await expect(resolveSafeAddresses(url, 'TEST')).resolves.toEqual([
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('rejects when any resolved address is blocked', async () => {
    const url = new URL('https://echo.example/');
    await expect(
      resolveSafeAddresses(url, 'TEST', {}, async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    ).rejects.toThrow(/blocked address 169\.254\.169\.254/);
  });

  it('returns the verified public address set', async () => {
    const url = new URL('https://echo.example/');
    await expect(
      resolveSafeAddresses(url, 'TEST', {}, async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '198.51.100.10', family: 4 },
      ]),
    ).resolves.toEqual([
      { address: '203.0.113.10', family: 4 },
      { address: '198.51.100.10', family: 4 },
    ]);
  });
});

describe('pinnedHttpsFetch', () => {
  it('dials only through the pinned lookup set', async () => {
    const lookupHost = vi.fn(async () => [{ address: '203.0.113.10', family: 4 as const }]);
    await expect(
      pinnedHttpsFetch('https://echo.example/ip', {
        lookupHost,
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(lookupHost).toHaveBeenCalled();
  });

  it('refuses to dial when DNS returns a blocked address', async () => {
    await expect(
      pinnedHttpsFetch('https://evil.example/ip', {
        lookupHost: async () => [{ address: '169.254.169.254', family: 4 }],
      }),
    ).rejects.toThrow(/blocked address/);
  });

  it('returns a Response from a successful pinned dial', async () => {
    const { agents } = installHttpsMocks({
      body: '203.0.113.50',
      headers: {
        'content-type': 'text/plain',
        'set-cookie': ['a=1', 'b=2'],
      },
      onRequest(options, agent) {
        expect(options.family).toBe(4);
        expect(options.servername).toBe('echo.example');
        agent.lookup?.('echo.example', { all: true, verbatim: true }, ((
          err: Error | null,
          addresses: LookupAddress[],
        ) => {
          expect(err).toBeNull();
          expect(addresses).toEqual([{ address: '203.0.113.10', family: 4 }]);
        }) as never);
        agent.lookup?.('echo.example', { verbatim: true }, ((
          err: Error | null,
          address: string,
          family: number,
        ) => {
          expect(err).toBeNull();
          expect(address).toBe('203.0.113.10');
          expect(family).toBe(4);
        }) as never);
      },
    });

    const response = await pinnedHttpsFetch('https://echo.example/ip', {
      lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      headers: { 'X-Test': '1' },
    });

    expect(response.status).toBe(200);
    expect(response.url).toBe('https://echo.example/ip');
    expect(await response.text()).toBe('203.0.113.50');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(agents[0]?.destroy).toHaveBeenCalled();
  });

  it('prefers IPv4 when the pin set is dual-stack', async () => {
    installHttpsMocks({
      onRequest(options, agent) {
        expect(options.family).toBe(4);
        agent.lookup?.('echo.example', { all: true, verbatim: true }, ((
          _err: Error | null,
          addresses: LookupAddress[],
        ) => {
          expect(addresses).toEqual([{ address: '203.0.113.10', family: 4 }]);
        }) as never);
      },
    });

    await pinnedHttpsFetch(new URL('https://echo.example/'), {
      lookupHost: async (): Promise<LookupAddress[]> => [
        { address: '2001:db8::1', family: 6 },
        { address: '203.0.113.10', family: 4 },
      ],
    });
  });

  it('uses IPv6 family when only AAAA addresses are available', async () => {
    installHttpsMocks({
      onRequest(options) {
        expect(options.family).toBe(6);
      },
    });

    await pinnedHttpsFetch('https://echo.example/', {
      lookupHost: async () => [{ address: '2001:db8::1', family: 6 }],
    });
  });

  it('rejects unexpected redirects by default', async () => {
    installHttpsMocks({
      statusCode: 302,
      headers: { location: '/elsewhere' },
    });

    await expect(
      pinnedHttpsFetch('https://echo.example/start', {
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/Unexpected redirect/);
  });

  it('follows same-host HTTPS redirects and drops the body', async () => {
    let calls = 0;
    const { reqs } = installHttpsMocks({
      onRequest() {
        calls += 1;
      },
    });
    vi.mocked(https.request).mockImplementation(((
      _options: https.RequestOptions,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const req = createMockReq();
      reqs.push(req);
      const hop = reqs.length;
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        if (hop === 1) {
          Object.defineProperty(res, 'statusCode', { value: 301 });
          Object.defineProperty(res, 'headers', { value: { location: '/final' } });
        } else {
          Object.defineProperty(res, 'statusCode', { value: 200 });
          Object.defineProperty(res, 'headers', { value: {} });
        }
        callback?.(res);
        res.emit('data', Buffer.from(hop === 1 ? 'redirect' : 'done'));
        res.emit('end');
      });
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);

    // Keep Agent constructable for redirect hops.
    function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
      this.destroy = vi.fn();
      this.lookup = options?.lookup;
    }
    vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);

    const response = await pinnedHttpsFetch('https://echo.example/start', {
      method: 'POST',
      body: 'payload',
      redirect: 'follow',
      lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
    });

    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.write).toHaveBeenCalledWith('payload');
    expect(reqs[1]?.write).not.toHaveBeenCalled();
    expect(await response.text()).toBe('done');
    expect(response.url).toBe('https://echo.example/final');
    expect(calls).toBe(0); // onRequest from first install overwritten
  });

  it('rejects redirects that leave HTTPS or change host', async () => {
    installHttpsMocks({
      statusCode: 302,
      headers: { location: 'http://echo.example/x' },
    });
    await expect(
      pinnedHttpsFetch('https://echo.example/', {
        redirect: 'follow',
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/Redirect left HTTPS/);

    installHttpsMocks({
      statusCode: 302,
      headers: { location: 'https://other.example/x' },
    });
    await expect(
      pinnedHttpsFetch('https://echo.example/', {
        redirect: 'follow',
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/Redirect changed host/);
  });

  it('returns redirect responses that omit Location', async () => {
    installHttpsMocks({
      statusCode: 302,
      headers: {},
      body: '',
    });
    const response = await pinnedHttpsFetch('https://echo.example/', {
      lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
    });
    expect(response.status).toBe(302);
  });

  it('rejects when too many redirects are followed', async () => {
    function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
      this.destroy = vi.fn();
      this.lookup = options?.lookup;
    }
    vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);
    vi.spyOn(https, 'request').mockImplementation(((
      _options: https.RequestOptions,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const req = createMockReq();
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        Object.defineProperty(res, 'statusCode', { value: 302 });
        Object.defineProperty(res, 'headers', { value: { location: '/next' } });
        callback?.(res);
        res.emit('end');
      });
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);

    await expect(
      pinnedHttpsFetch('https://echo.example/start', {
        redirect: 'follow',
        maxRedirects: 1,
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('aborts an in-flight pinned request', async () => {
    const controller = new AbortController();
    function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
      this.destroy = vi.fn();
      this.lookup = options?.lookup;
    }
    vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);
    vi.spyOn(https, 'request').mockImplementation((() => {
      const req = createMockReq();
      queueMicrotask(() => controller.abort());
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);

    await expect(
      pinnedHttpsFetch('https://echo.example/', {
        signal: controller.signal,
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const signal = AbortSignal.abort(new Error('already done'));
    installHttpsMocks({ respond: false });
    await expect(
      pinnedHttpsFetch('https://echo.example/', {
        signal,
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/aborted|already done/);
  });

  it('rejects non-HTTPS URLs before dialing', async () => {
    await expect(
      pinnedHttpsFetch('http://echo.example/', {
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/Refusing non-HTTPS/);
  });

  it('propagates response stream errors', async () => {
    function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
      this.destroy = vi.fn();
      this.lookup = options?.lookup;
    }
    vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);
    vi.spyOn(https, 'request').mockImplementation(((
      _options: https.RequestOptions,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const req = createMockReq();
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        Object.defineProperty(res, 'statusCode', { value: 200 });
        Object.defineProperty(res, 'headers', { value: {} });
        callback?.(res);
        res.emit('error', new Error('stream failed'));
      });
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);

    await expect(
      pinnedHttpsFetch('https://echo.example/', {
        lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow(/stream failed/);
  });

  it('keeps an explicit Host header and skips body on HEAD', async () => {
    installHttpsMocks({
      onRequest(options) {
        expect(options.headers).toMatchObject({ host: 'custom.example' });
        expect(options.method).toBe('HEAD');
      },
    });
    await pinnedHttpsFetch('https://echo.example/', {
      method: 'HEAD',
      body: 'ignored',
      headers: { Host: 'custom.example' },
      lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
    });
  });

  it('accepts array Location headers when following redirects', async () => {
    const { reqs } = installHttpsMocks({});
    function MockAgent(this: MockAgentInstance, options?: https.AgentOptions) {
      this.destroy = vi.fn();
      this.lookup = options?.lookup;
    }
    vi.spyOn(https, 'Agent').mockImplementation(MockAgent as unknown as typeof https.Agent);
    vi.spyOn(https, 'request').mockImplementation(((
      _options: https.RequestOptions,
      callback?: (res: IncomingMessage) => void,
    ) => {
      const req = createMockReq();
      reqs.push(req);
      const hop = reqs.length;
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        if (hop === 1) {
          Object.defineProperty(res, 'statusCode', { value: 302 });
          Object.defineProperty(res, 'headers', {
            value: { location: ['/final', '/ignored'] },
          });
        } else {
          Object.defineProperty(res, 'statusCode', { value: 200 });
          Object.defineProperty(res, 'headers', {
            value: { 'x-empty': undefined, 'x-list': ['a', 'b'] },
          });
        }
        callback?.(res);
        res.emit('data', Buffer.from(hop === 1 ? '' : 'ok'));
        res.emit('end');
      });
      return req as unknown as ReturnType<typeof https.request>;
    }) as unknown as typeof https.request);

    const response = await pinnedHttpsFetch('https://echo.example/start', {
      redirect: 'follow',
      headers: new Headers({ Accept: 'text/plain' }),
      lookupHost: async () => [{ address: '203.0.113.10', family: 4 }],
    });
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('x-list')).toBe('a, b');
  });
});
