import { describe, expect, it } from 'vite-plus/test';

import {
  assertHttpsUrl,
  assertResolvedHttpsHostSafe,
  isBlockedOutboundHost,
  resolveSafeAddresses,
} from '../lib/url-policy.js';

describe('url policy', () => {
  it('accepts public https URLs without userinfo', () => {
    expect(assertHttpsUrl('https://example.com/path', 'TEST').hostname).toBe('example.com');
  });

  it('rejects cleartext, userinfo, and blocked hosts', () => {
    expect(() => assertHttpsUrl('http://example.com', 'TEST')).toThrow(/valid https/);
    expect(() => assertHttpsUrl('https://user:pass@example.com', 'TEST')).toThrow(/credentials/);
    expect(() => assertHttpsUrl('https://127.0.0.1/x', 'TEST')).toThrow(/loopback, private/);
    expect(() => assertHttpsUrl('https://169.254.169.254/x', 'TEST')).toThrow(/loopback, private/);
    expect(() => assertHttpsUrl('https://10.0.0.1/x', 'TEST')).toThrow(/loopback, private/);
    expect(() => assertHttpsUrl('https://169.254.169.254.nip.io/x', 'TEST')).toThrow(
      /loopback, private/,
    );
    expect(() => assertHttpsUrl('https://10.0.0.1.sslip.io/x', 'TEST')).toThrow(
      /loopback, private/,
    );
  });

  it('can allow RFC1918 hosts when opted in, but not metadata or loopback', () => {
    expect(assertHttpsUrl('https://10.0.0.1/ntfy', 'TEST', { allowPrivateHosts: true }).href).toBe(
      'https://10.0.0.1/ntfy',
    );
    expect(() =>
      assertHttpsUrl('https://169.254.169.254/x', 'TEST', { allowPrivateHosts: true }),
    ).toThrow(/loopback, link-local, or cloud-metadata/);
    expect(() =>
      assertHttpsUrl('https://127.0.0.1/x', 'TEST', { allowPrivateHosts: true }),
    ).toThrow(/loopback, link-local, or cloud-metadata/);
    expect(() =>
      assertHttpsUrl('https://metadata.google.internal/x', 'TEST', { allowPrivateHosts: true }),
    ).toThrow(/loopback, link-local, or cloud-metadata/);
    expect(() =>
      assertHttpsUrl('https://169.254.169.254.nip.io/x', 'TEST', { allowPrivateHosts: true }),
    ).toThrow(/loopback, link-local, or cloud-metadata/);
  });

  it('classifies blocked outbound hosts', () => {
    expect(isBlockedOutboundHost('localhost')).toBe(true);
    expect(isBlockedOutboundHost('metadata.google.internal')).toBe(true);
    expect(isBlockedOutboundHost('192.168.1.1')).toBe(true);
    expect(isBlockedOutboundHost('example.com')).toBe(false);
    // Node normalizes [::ffff:169.254.169.254] to ::ffff:a9fe:a9fe
    expect(isBlockedOutboundHost('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(isBlockedOutboundHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(() => assertHttpsUrl('https://[::ffff:169.254.169.254]/x', 'TEST')).toThrow(
      /loopback, private/,
    );
    // Mapped private RFC1918 and ULA / link-local IPv6
    expect(isBlockedOutboundHost('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedOutboundHost('::ffff:0a00:0001')).toBe(true);
    expect(isBlockedOutboundHost('fc00::1')).toBe(true);
    expect(isBlockedOutboundHost('fd12:3456::1')).toBe(true);
    expect(isBlockedOutboundHost('fe80::1')).toBe(true);
    expect(isBlockedOutboundHost('::1')).toBe(true);
    expect(isBlockedOutboundHost('2001:db8::1')).toBe(false);
    expect(isBlockedOutboundHost('::ffff:10.0.0.1', { allowPrivateHosts: true })).toBe(false);
    expect(isBlockedOutboundHost('fc00::1', { allowPrivateHosts: true })).toBe(false);
    expect(isBlockedOutboundHost('100.64.0.1')).toBe(true); // CGNAT
    expect(isBlockedOutboundHost('172.16.5.1')).toBe(true);
    expect(isBlockedOutboundHost('0.0.0.0')).toBe(true);
    expect(isBlockedOutboundHost('::')).toBe(true);
    expect(isBlockedOutboundHost('169.254.0.1')).toBe(true);
    expect(isBlockedOutboundHost('172.15.0.1')).toBe(false);
    expect(isBlockedOutboundHost('192.0.2.1')).toBe(false);
    expect(isBlockedOutboundHost('100.63.0.1')).toBe(false);
  });

  it('resolveSafeAddresses covers protocol, literal, empty, and lookup failures', async () => {
    await expect(resolveSafeAddresses(new URL('http://example.com/'), 'TEST')).rejects.toThrow(
      /valid https/,
    );
    await expect(resolveSafeAddresses(new URL('https://127.0.0.1/'), 'TEST')).rejects.toThrow(
      /loopback, private/,
    );
    await expect(
      resolveSafeAddresses(new URL('https://127.0.0.1/'), 'TEST', { allowPrivateHosts: true }),
    ).rejects.toThrow(/loopback, link-local, or cloud-metadata/);
    await expect(resolveSafeAddresses(new URL('https://[2001:db8::1]/'), 'TEST')).resolves.toEqual([
      { address: '2001:db8::1', family: 6 },
    ]);
    await expect(
      resolveSafeAddresses(new URL('https://empty.example/'), 'TEST', {}, async () => []),
    ).rejects.toThrow(/no addresses/);
    await expect(
      resolveSafeAddresses(new URL('https://boom.example/'), 'TEST', {}, async () => {
        throw 'dns exploded';
      }),
    ).rejects.toThrow(/could not be resolved \(dns exploded\)/);
    await expect(
      resolveSafeAddresses(new URL('https://err.example/'), 'TEST', {}, async () => {
        throw new Error('lookup failed');
      }),
    ).rejects.toThrow(/could not be resolved \(lookup failed\)/);
    await expect(
      assertResolvedHttpsHostSafe(new URL('https://ok.example/'), 'TEST', {}, async () => [
        { address: '203.0.113.10', family: 4 },
      ]),
    ).resolves.toBeUndefined();
    // Embedded labels that look like IPv4 but are out of range are ignored.
    expect(isBlockedOutboundHost('999.999.999.999.nip.io')).toBe(false);
    expect(isBlockedOutboundHost('1.2.3.nip.io')).toBe(false);
  });
});
