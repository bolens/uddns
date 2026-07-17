import { describe, expect, it } from 'vite-plus/test';

import { requireFields, requireIPv4 } from '../../lib/providers/guards.js';

describe('requireFields', () => {
  it('returns null when every required value is truthy', () => {
    expect(
      requireFields('missing', ['user', 'pass'], {
        hasUser: true,
        hasPassword: true,
      }),
    ).toBeNull();
  });

  it('returns a fail result with the caller-supplied message and details', () => {
    expect(
      requireFields('duckdns requires token', [null, 'token'], {
        hasDomains: false,
        hasToken: true,
      }),
    ).toEqual({
      ok: false,
      message: 'duckdns requires token',
      details: {
        hasDomains: false,
        hasToken: true,
      },
    });
  });
});

describe('requireIPv4', () => {
  it('returns null when an IPv4 address is present', () => {
    expect(requireIPv4({ v4: '1.2.3.4', v6: null }, { host: 'x' })).toBeNull();
  });

  it('fails with the shared no-IPv4 message and merges details', () => {
    const ip = { v4: null, v6: '2001:db8::1' };
    expect(requireIPv4(ip, { hostname: 'home.example.com' })).toEqual({
      ok: false,
      message: 'No public IPv4 available',
      details: {
        hostname: 'home.example.com',
        ip,
      },
    });
  });
});
