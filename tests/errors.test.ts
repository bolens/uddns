import { describe, expect, it } from 'vite-plus/test';

import { errorMessage, getErrorProp, hasErrorCode, networkErrorFields } from '../lib/errors.js';

describe('errorMessage', () => {
  it('reads Error.message and stringifies non-Errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});

describe('getErrorProp', () => {
  it('returns a property from object-like errors and undefined otherwise', () => {
    expect(getErrorProp({ code: 'ENOENT' }, 'code')).toBe('ENOENT');
    expect(getErrorProp({ status: 503 }, 'status')).toBe(503);
    expect(getErrorProp(new Error('x'), 'code')).toBeUndefined();
    expect(getErrorProp(null, 'code')).toBeUndefined();
    expect(getErrorProp('string', 'code')).toBeUndefined();
  });
});

describe('hasErrorCode', () => {
  it('matches exact error codes', () => {
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(true);
    expect(hasErrorCode({ code: 'EACCES' }, 'ENOENT')).toBe(false);
    expect(hasErrorCode(new Error('missing'), 'ENOENT')).toBe(false);
  });
});

describe('networkErrorFields', () => {
  it('plucks only defined Node network fields', () => {
    expect(
      networkErrorFields({
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'missing.example',
        extra: 'ignored',
      }),
    ).toEqual({
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: 'missing.example',
    });

    expect(networkErrorFields({ code: 'ECONNRESET' })).toEqual({ code: 'ECONNRESET' });
    expect(networkErrorFields(null)).toEqual({});
    expect(networkErrorFields({ syscall: 1, hostname: 2 })).toEqual({});
  });
});
