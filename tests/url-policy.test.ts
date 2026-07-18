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
  });

  it('can allow private hosts when opted in', () => {
    expect(assertHttpsUrl('https://10.0.0.1/ntfy', 'TEST', { allowPrivateHosts: true }).href).toBe(
      'https://10.0.0.1/ntfy',
    );
  });

  it('classifies blocked outbound hosts', () => {
    expect(isBlockedOutboundHost('localhost')).toBe(true);
    expect(isBlockedOutboundHost('metadata.google.internal')).toBe(true);
    expect(isBlockedOutboundHost('192.168.1.1')).toBe(true);
    expect(isBlockedOutboundHost('example.com')).toBe(false);
  });
});
