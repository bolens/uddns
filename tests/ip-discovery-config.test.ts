import { describe, expect, it, vi } from 'vite-plus/test';

import { discoverPublicIP } from '../lib/ip.js';

describe('configurable IP discovery', () => {
  it('uses custom HTTPS endpoints and can disable DNS fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('203.0.113.10'))
      .mockResolvedValueOnce(new Response('not-an-ip'));

    const result = await discoverPublicIP({
      fetch: fetchMock as typeof fetch,
      createResolver: () => {
        throw new Error('dns should not run');
      },
      httpsV4: ['https://example.com/v4'],
      httpsV6: ['https://example.com/v6'],
      dnsFallback: false,
      timeoutMs: 2000,
    });

    expect(result.ip.v4).toBe('203.0.113.10');
    expect(result.ip.v6).toBeNull();
    expect(result.errors.v6?.message).toMatch(/DNS fallback is disabled/);
  });
});
