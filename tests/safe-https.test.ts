import { describe, expect, it, vi } from 'vite-plus/test';

import { pinnedHttpsFetch } from '../lib/safe-https.js';
import { resolveSafeAddresses } from '../lib/url-policy.js';

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
    // Connecting to TEST-NET will fail at TCP; we only assert lookup was used
    // and blocked mixed sets never reach dial.
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
});
