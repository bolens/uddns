import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  discoverPublicIP,
  formatPublicIP,
  getPublicIP,
  ipChanged,
  mergePresentFamilies,
  type DiscoverDeps,
  type DnsResolver,
} from '../lib/ip.js';
import { fetchInputUrl } from './helpers/fetch.js';

function createStubResolver(handlers: {
  resolve4?: () => Promise<string[]>;
  resolve6?: () => Promise<string[]>;
  resolveTxt?: () => Promise<string[][]>;
}): DiscoverDeps['createResolver'] {
  return () =>
    ({
      setServers: vi.fn(),
      resolve4:
        handlers.resolve4 ??
        (async () => {
          throw new Error('resolve4 not stubbed');
        }),
      resolve6:
        handlers.resolve6 ??
        (async () => {
          throw new Error('resolve6 not stubbed');
        }),
      resolveTxt:
        handlers.resolveTxt ??
        (async () => {
          throw new Error('resolveTxt not stubbed');
        }),
    }) satisfies DnsResolver;
}

describe('discoverPublicIP', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers HTTPS (TLS-authenticated) sources and never consults DNS when they succeed', async () => {
    const resolverCreations: number[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      if (url.includes('ipv6') || url.includes('api64')) {
        return new Response('2001:db8::10\n');
      }
      return new Response('203.0.113.10\n');
    });

    const deps: DiscoverDeps = {
      fetch: fetchMock,
      createResolver: () => {
        resolverCreations.push(1);
        throw new Error('DNS must not be consulted when HTTPS succeeds');
      },
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered).toEqual({
      ip: { v4: '203.0.113.10', v6: '2001:db8::10' },
      errors: { v4: null, v6: null },
    });
    expect(resolverCreations).toHaveLength(0);
    expect(await getPublicIP(deps)).toEqual({ v4: '203.0.113.10', v6: '2001:db8::10' });
  });

  it('falls back to OpenDNS when the HTTPS endpoints fail', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('https echo services unreachable');
    });

    const deps: DiscoverDeps = {
      fetch: fetchMock,
      createResolver: createStubResolver({
        resolve4: async () => ['203.0.113.20'],
        resolve6: async () => ['2001:db8::20'],
      }),
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered.ip).toEqual({ v4: '203.0.113.20', v6: '2001:db8::20' });
    expect(discovered.errors.v4).toBeNull();
    expect(discovered.errors.v6).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('keeps ipv4 when ipv6 fails and records the ipv6 error', async () => {
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => {
        throw new Error('https down');
      }),
      createResolver: createStubResolver({
        resolve4: async () => ['203.0.113.10'],
        resolve6: async () => {
          throw Object.assign(new Error('no ipv6'), { code: 'ENETUNREACH' });
        },
        resolveTxt: async () => {
          throw new Error('txt fail');
        },
      }),
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered.ip).toEqual({ v4: '203.0.113.10', v6: null });
    expect(discovered.errors.v4).toBeNull();
    // Google TXT is the last resort now, so its error is the one reported.
    expect(discovered.errors.v6).toMatchObject({
      message: expect.stringContaining('txt fail') as string,
    });
  });

  it('returns nulls and both errors when discovery fully fails', async () => {
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => {
        throw new Error('https down');
      }),
      createResolver: createStubResolver({
        resolve4: async () => {
          throw new Error('ipv4 down');
        },
        resolve6: async () => {
          throw new Error('ipv6 down');
        },
        resolveTxt: async () => {
          throw new Error('txt down');
        },
      }),
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered.ip).toEqual({ v4: null, v6: null });
    expect(discovered.errors.v4).toMatchObject({ message: expect.any(String) as string });
    expect(discovered.errors.v6).toMatchObject({ message: expect.any(String) as string });
  });

  it('rejects invalid OpenDNS answers and falls back to Google DNS TXT', async () => {
    const txtServers: string[][] = [];
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => {
        throw new Error('https down');
      }),
      createResolver: () => ({
        setServers: (servers: string[]) => {
          txtServers.push(servers);
        },
        // OpenDNS answers with garbage; Google TXT has the real address.
        resolve4: async () => ['not-an-ip'],
        resolve6: async () => ['also-bad'],
        // TXT records may be split into chunks; they must be joined.
        resolveTxt: async () => [['203.0.', '113.30']],
      }),
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered.ip.v4).toBe('203.0.113.30');
    // The v4-family chain queried Google's v4 resolvers for the TXT record.
    expect(txtServers.flat()).toContain('8.8.8.8');
  });

  it('skips HTTPS endpoints that return error statuses and reports them on failure', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      if (url.includes('ipv6') || url.includes('api64')) {
        throw new Error('v6 unreachable');
      }
      if (url.includes('icanhazip')) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response('198.51.100.9');
    });

    const deps: DiscoverDeps = {
      fetch: fetchMock,
      createResolver: createStubResolver({}),
    };

    const discovered = await discoverPublicIP(deps);
    expect(discovered.ip.v4).toBe('198.51.100.9');

    const allFail: DiscoverDeps = {
      fetch: vi.fn(async () => new Response('nope', { status: 503 })),
      createResolver: createStubResolver({
        resolve4: async () => {
          throw new Error('opendns down');
        },
        resolve6: async () => {
          throw new Error('opendns down');
        },
        resolveTxt: async () => {
          throw new Error('google txt down');
        },
      }),
    };

    const failed = await discoverPublicIP(allFail);
    expect(failed.ip).toEqual({ v4: null, v6: null });
    // Google TXT is the last source tried, so its failure is the one reported.
    expect(failed.errors.v4).toMatchObject({
      message: expect.stringContaining('google txt down') as string,
    });
  });

  it('rejects invalid HTTPS bodies and continues to the next endpoint', async () => {
    const v4Calls: string[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = fetchInputUrl(input);
      if (url.includes('ipv6') || url.includes('api64')) {
        throw new Error('skip v6');
      }
      v4Calls.push(url);
      if (v4Calls.length === 1) {
        return new Response('not-an-ip');
      }
      return new Response('198.51.100.7');
    });

    const deps: DiscoverDeps = {
      fetch: fetchMock,
      createResolver: createStubResolver({
        resolve4: async () => {
          throw new Error('dns down');
        },
        resolve6: async () => {
          throw new Error('dns6 down');
        },
        resolveTxt: async () => {
          throw new Error('txt down');
        },
      }),
    };

    const discovered = await discoverPublicIP(deps);
    expect(discovered.ip.v4).toBe('198.51.100.7');
    expect(v4Calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a timeout when the fallback chain is still running at the deadline', async () => {
    // Google TXT hangs past the deadline after OpenDNS fails fast.
    const txtHangs: DiscoverDeps = {
      fetch: vi.fn(),
      createResolver: createStubResolver({
        resolve4: async () => {
          throw new Error('opendns down');
        },
        resolve6: async () => {
          throw new Error('opendns down');
        },
        resolveTxt: () => new Promise<string[][]>(() => {}),
      }),
      timeoutMs: 5,
    };

    const first = await discoverPublicIP(txtHangs);
    expect(first.errors.v4).toMatchObject({ message: 'Public IP discovery timed out' });

    // HTTPS requests are cancelled by the shared abort signal.
    const httpsHangs: DiscoverDeps = {
      fetch: vi.fn(
        (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('This operation was aborted'));
            });
          }),
      ),
      createResolver: createStubResolver({
        resolve4: async () => {
          throw new Error('dns down');
        },
        resolve6: async () => {
          throw new Error('dns down');
        },
        resolveTxt: async () => {
          throw new Error('txt down');
        },
      }),
      timeoutMs: 5,
    };

    const second = await discoverPublicIP(httpsHangs);
    expect(second.ip).toEqual({ v4: null, v6: null });
    expect(second.errors.v4).toMatchObject({ message: 'Public IP discovery timed out' });
    expect(second.errors.v6).toMatchObject({ message: 'Public IP discovery timed out' });
  });

  it('aborts both family lookups at the overall timeout', async () => {
    const never = new Promise<string[]>(() => {});
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => {
        throw new Error('https down');
      }),
      createResolver: createStubResolver({
        resolve4: () => never,
        resolve6: () => never,
      }),
      timeoutMs: 5,
    };

    const discovered = await discoverPublicIP(deps);

    expect(discovered.ip).toEqual({ v4: null, v6: null });
    expect(discovered.errors.v4).toMatchObject({
      message: 'Public IP discovery timed out',
    });
    expect(discovered.errors.v6).toMatchObject({
      message: 'Public IP discovery timed out',
    });
  });
});

describe('ipChanged', () => {
  it('detects present-family changes and ignores omitted (null) families', () => {
    const base = { v4: '1.1.1.1', v6: '::1' };
    expect(ipChanged({ v4: '8.8.8.8', v6: '::1' }, base)).toBe(true);
    expect(ipChanged({ v4: '1.1.1.1', v6: '::2' }, base)).toBe(true);
    expect(ipChanged({ ...base }, base)).toBe(false);
    // Omitted families (IP_MISSING=clear) must not look like a change.
    expect(ipChanged({ v4: null, v6: null }, base)).toBe(false);
    expect(ipChanged({ v4: '1.1.1.1', v6: null }, base)).toBe(false);
    expect(ipChanged({ v4: '8.8.8.8', v6: null }, base)).toBe(true);
  });
});

describe('mergePresentFamilies', () => {
  it('keeps previous families when the next snapshot omits them', () => {
    expect(mergePresentFamilies({ v4: '1.1.1.1', v6: '::1' }, { v4: '9.9.9.9', v6: null })).toEqual(
      { v4: '9.9.9.9', v6: '::1' },
    );
  });
});

describe('formatPublicIP', () => {
  it('formats available families and none', () => {
    expect(formatPublicIP({ v4: '1.2.3.4', v6: null })).toBe('IPv4 1.2.3.4');
    expect(formatPublicIP({ v4: '1.2.3.4', v6: '::1' })).toBe('IPv4 1.2.3.4, IPv6 ::1');
    expect(formatPublicIP({ v4: null, v6: null })).toBe('(none)');
  });
});
