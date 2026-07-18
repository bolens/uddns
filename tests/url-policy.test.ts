import { describe, expect, it } from 'vite-plus/test';

import { assertHttpsUrl, isBlockedOutboundHost } from '../lib/url-policy.js';

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
  });
});
