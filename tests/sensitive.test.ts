import { describe, expect, it } from 'vite-plus/test';

import { redact } from '../lib/log.js';
import { sanitizeUrl } from '../lib/providers/http.js';
import { isSensitiveKey, SENSITIVE_KEY_PATTERN } from '../lib/sensitive.js';

describe('isSensitiveKey', () => {
  it('matches the shared sensitive-key set', () => {
    const keys = [
      'password',
      'pass',
      'token',
      'secret',
      'authorization',
      'api-key',
      'api_key',
      'credential',
      'private',
      'auth',
      'key',
    ];
    for (const key of keys) {
      expect(isSensitiveKey(key), key).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test(key), key).toBe(true);
    }
    expect(isSensitiveKey('hostname')).toBe(false);
    expect(isSensitiveKey('status')).toBe(false);
  });

  it('keeps log redact and URL sanitize covering the same key set', () => {
    const keys = [
      'password',
      'token',
      'secret',
      'authorization',
      'apiKey',
      'credential',
      'privateKey',
      'auth',
      'key',
    ];

    for (const key of keys) {
      const redacted = redact({ [key]: 'super-secret' }) as Record<string, unknown>;
      expect(redacted[key], `log redact for ${key}`).toBe('[redacted]');

      const url = sanitizeUrl(`https://example.com/update?${key}=super-secret&keep=1`);
      expect(url, `url sanitize for ${key}`).toContain(`${key}=%5Bredacted%5D`);
      expect(url).toContain('keep=1');
      expect(url).not.toContain('super-secret');
    }
  });
});
