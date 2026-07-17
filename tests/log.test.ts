import { describe, expect, it, vi } from 'vite-plus/test';

import { createLogger, formatError, formatTimestamp, normalizeLevel, redact } from '../lib/log.js';

describe('normalizeLevel', () => {
  it('accepts known levels and falls back to info', () => {
    expect(normalizeLevel('debug')).toBe('debug');
    expect(normalizeLevel('WARN')).toBe('warn');
    expect(normalizeLevel('nope')).toBe('info');
  });
});

describe('redact', () => {
  it('masks sensitive keys and auth headers', () => {
    expect(
      redact({
        token: 'secret',
        password: 'hunter2',
        apiToken: 'cf',
        nested: { authorization: 'Bearer abc', host: 'example.com' },
      }),
    ).toEqual({
      token: '[redacted]',
      password: '[redacted]',
      apiToken: '[redacted]',
      nested: { authorization: '[redacted]', host: 'example.com' },
    });

    expect(redact('Bearer abc.def')).toBe('[redacted]');
    expect(redact('Basic dXNlcjpwYXNz')).toBe('[redacted]');
    expect(redact(['Bearer abc', 'plain'])).toEqual(['[redacted]', 'plain']);
  });

  it('scrubs credentials embedded mid-string (echoed headers, response bodies)', () => {
    expect(redact('request failed: Authorization: Bearer abc.123 (rejected)')).toBe(
      'request failed: Authorization: Bearer [redacted] (rejected)',
    );
    expect(redact('proxy said Basic dXNlcjpwYXNz then closed')).toBe(
      'proxy said Basic [redacted] then closed',
    );
    expect(redact('no secrets here')).toBe('no secrets here');
  });
});

describe('formatError', () => {
  it('includes stack and cause chain', () => {
    const root = new Error('root');
    root.cause = Object.assign(new Error('network'), { code: 'ENOTFOUND' });
    const formatted = formatError(root);
    expect(formatted.message).toBe('root');
    expect(formatted.stack).toEqual(expect.any(String));
    expect(formatted.cause).toMatchObject({ message: 'network', code: 'ENOTFOUND' });
  });

  it('extracts network fields (code, errno, syscall, hostname) from errors', () => {
    const error = Object.assign(new Error('getaddrinfo failed'), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: 'api.example.com',
    });

    expect(formatError(error)).toMatchObject({
      message: 'getaddrinfo failed',
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: 'api.example.com',
    });
  });

  it('redacts and JSON-normalizes non-Error objects', () => {
    const formatted = formatError({
      token: 'super-secret',
      note: 'context',
      big: 10n,
      sym: Symbol('marker'),
      fn: function namedFn() {},
      missing: undefined,
      list: [1, 'two'],
    });

    expect(formatted.message).toBe('Non-Error object');
    expect(formatted['value']).toEqual({
      token: '[redacted]',
      note: 'context',
      big: '10',
      sym: 'marker',
      fn: '[Function namedFn]',
      missing: 'undefined',
      list: [1, 'two'],
    });
  });

  it('stringifies primitive throwables', () => {
    expect(formatError('boom')).toEqual({ message: 'boom' });
    expect(formatError(42)).toEqual({ message: '42' });
    expect(formatError(undefined)).toEqual({ message: 'undefined' });
  });

  it('redacts credentials leaked into error messages, stacks, and causes', () => {
    const error = new Error('upstream echoed Authorization: Bearer super-secret-token');
    error.cause = new Error('retry with Basic dXNlcjpwYXNz header');

    const formatted = formatError(error);

    expect(formatted.message).toBe('upstream echoed Authorization: Bearer [redacted]');
    expect(formatted.stack).not.toContain('super-secret-token');
    expect(formatted.cause?.message).toBe('retry with Basic [redacted] header');
  });
});

describe('formatTimestamp', () => {
  it('formats local dates without a third-party date library', () => {
    const date = new Date(2026, 6, 17, 8, 4, 9);
    expect(formatTimestamp(date)).toBe('2026-07-17 08:04:09');
  });
});

describe('createLogger', () => {
  it('honors log levels and prints context blocks', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const error = vi.fn();
    const logger = createLogger({
      level: 'info',
      now: () => new Date(2026, 6, 17, 8, 4, 9),
      info,
      debug,
      error,
    });

    logger.debug('hidden');
    logger.info('visible', { token: 'secret', host: 'a.example.com' });
    logger.error('boom', new Error('nope'));

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('2026-07-17 08:04:09'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('visible'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[redacted]'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('a.example.com'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('emits warn and debug output when the level allows it', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const debug = vi.fn();
    const logger = createLogger({ level: 'debug', info, warn, debug });

    logger.warn('careful', { retries: 3 });
    logger.debug('verbose', { cycle: 1 });
    logger.success('done');

    expect(logger.level).toBe('debug');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('⚠'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('careful'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"retries": 3'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('verbose'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('✔'));
  });

  it('suppresses everything below the error threshold', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const logger = createLogger({ level: 'error', info, warn, error });

    logger.info('nope');
    logger.success('nope');
    logger.warn('nope');
    logger.debug('nope');
    logger.error('yes');

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('falls back to console writers and UDDNS_LOG_LEVEL by default', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('UDDNS_LOG_LEVEL', 'debug');

    try {
      const logger = createLogger();
      expect(logger.level).toBe('debug');

      logger.info('to stdout');
      logger.warn('to warn');
      logger.error('to stderr');
      logger.debug('debug goes to info writer');

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining('to stdout'));
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('debug goes to info writer'),
      );
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('to warn'));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('to stderr'));
    } finally {
      vi.unstubAllEnvs();
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('falls back to String() for unserializable context', () => {
    const info = vi.fn();
    const logger = createLogger({ level: 'info', info });

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    logger.info('cyclic context', cyclic);

    expect(info).toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
  });
});
