import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { main } from '../app.js';
import type { Logger } from '../lib/log.js';
import type { Provider } from '../lib/schemas/provider.js';
import { makeConfig } from './helpers/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function silentLog(): Logger {
  return {
    level: 'info',
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

const stubProvider: Provider = {
  id: 'cloudflare',
  label: 'Cloudflare',
  update: async () => ({ ok: true, message: 'ok' }),
};

function stubUpdater(stop: () => Promise<void> = async () => {}) {
  return {
    start: vi.fn(async () => ({ stop })),
    stop: vi.fn(stop),
    checkOnce: vi.fn(async () => ({
      status: 'unchanged' as const,
      ip: { v4: null, v6: null },
      message: 'unchanged',
    })),
    getCurrentIP: () => ({ v4: null, v6: null }),
  };
}

describe('application entrypoint', () => {
  it('validates configuration without starting the updater', async () => {
    const log = silentLog();
    const createUpdaterFn = vi.fn();

    await main({
      argv: ['--check-config'],
      env: {},
      log,
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => ({
        id: 'cloudflare',
        label: 'Cloudflare',
        update: async () => ({ ok: true, message: 'ok' }),
      }),
      createUpdaterFn,
      on: vi.fn(),
      exit: vi.fn(),
    });

    expect(createUpdaterFn).not.toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });

  it('waits for updater shutdown before exiting on a signal', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();
    let releaseStop: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const updater = {
      start: vi.fn(async () => ({ stop })),
      stop,
      checkOnce: vi.fn(async () => ({
        status: 'unchanged' as const,
        ip: { v4: null, v6: null },
        message: 'unchanged',
      })),
      getCurrentIP: () => ({ v4: null, v6: null }),
    };

    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => ({
        id: 'cloudflare',
        label: 'Cloudflare',
        update: async () => ({ ok: true, message: 'ok' }),
      }),
      createUpdaterFn: () => updater,
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      exit,
    });

    listeners.get('SIGTERM')?.();
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    releaseStop?.();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it('logs startup failures and exits non-zero', async () => {
    const log = silentLog();
    const exit = vi.fn();

    await main({
      env: {},
      log,
      loadConfigFn: () => {
        throw new Error('invalid config');
      },
      on: vi.fn(),
      exit,
    });

    expect(log.error).toHaveBeenCalledWith(
      'Failed to start updater',
      expect.objectContaining({ message: 'invalid config' }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero on uncaught exceptions and unhandled rejections', async () => {
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
      const listeners = new Map<string, (value?: unknown) => void>();
      const exit = vi.fn();
      const log = silentLog();

      await main({
        env: {},
        log,
        loadConfigFn: () => makeConfig(),
        getProviderFn: () => stubProvider,
        createUpdaterFn: () => stubUpdater(),
        on: (name, listener) => {
          listeners.set(name, listener);
        },
        exit,
      });

      listeners.get(event)?.(new Error('boom'));
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledWith(1);
      });
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('exiting'),
        expect.objectContaining({ message: 'boom' }),
      );
    }
  });

  it('runs shutdown only once when multiple signals arrive', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();
    const updater = stubUpdater();

    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      on: (name, listener) => {
        listeners.set(name, listener);
      },
      exit,
    });

    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(updater.stop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits non-zero when graceful shutdown itself fails', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();
    const log = silentLog();
    const updater = stubUpdater(async () => {
      throw new Error('stop failed');
    });

    await main({
      env: {},
      log,
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      on: (name, listener) => {
        listeners.set(name, listener);
      },
      exit,
    });

    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(log.error).toHaveBeenCalledWith(
      'Graceful shutdown failed',
      expect.objectContaining({ message: 'stop failed' }),
    );
  });

  it('wires process signal handlers and process.exit by default', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // Never actually exit the test process.
    }) as never);
    const registered: string[] = [];

    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => {
        throw new Error('fail before listeners leak');
      },
    });
    expect(exitSpy).toHaveBeenCalledWith(1);

    const updater = stubUpdater();
    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
    });

    for (const call of onSpy.mock.calls) {
      registered.push(String(call[0]));
      process.removeListener(call[0] as 'SIGINT', call[1] as () => void);
    }
    expect(registered).toEqual(
      expect.arrayContaining(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']),
    );
    expect(updater.start).toHaveBeenCalledOnce();
  });

  it('reads argv and env from the process by default', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'app.js', '--check-config'];
    const log = silentLog();
    const loadConfigFn = vi.fn(() => makeConfig());

    try {
      await main({
        log,
        loadConfigFn,
        getProviderFn: () => stubProvider,
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(loadConfigFn).toHaveBeenCalledWith(process.env);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });
});
