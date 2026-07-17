import { describe, expect, it, vi } from 'vite-plus/test';

import { main } from '../mcp.js';
import { deferred } from './helpers/async.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { makeConfig } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider, stubUpdater } from './helpers/provider.js';

afterEachRestoreMocks();

const stubProvider = mockProvider(async () => ({ ok: true, message: 'ok' }), {
  id: 'cloudflare',
  label: 'Cloudflare',
});

function stdioOk() {
  return {
    connectStdioFn: vi.fn(async () => ({
      close: vi.fn(async () => {}),
    })),
  };
}

function httpOk() {
  return {
    startHttpFn: vi.fn(async () => ({
      app: {} as never,
      httpServer: {} as never,
      url: 'http://127.0.0.1:3923/mcp',
      close: vi.fn(async () => {}),
    })),
  };
}

describe('MCP entrypoint', () => {
  it('validates configuration without starting the updater', async () => {
    const log = silentLog();
    const createUpdaterFn = vi.fn();

    await main({
      argv: ['--check-config'],
      env: {},
      log,
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn,
      on: vi.fn(),
      exit: vi.fn(),
    });

    expect(createUpdaterFn).not.toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid'));
  });

  it('starts the updater loop for HTTP transport', async () => {
    const updater = stubUpdater();
    const { startHttpFn } = httpOk();
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();

    await main({
      argv: ['--transport', 'http'],
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      startHttpFn,
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      exit,
    });

    expect(updater.start).toHaveBeenCalledOnce();
    expect(startHttpFn).toHaveBeenCalledOnce();

    listeners.get('SIGTERM')?.();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(startHttpFn.mock.results[0]?.value).toBeDefined();
    await expect(startHttpFn.mock.results[0]!.value).resolves.toMatchObject({
      close: expect.any(Function),
    });
  });

  it('connects stdio without auto-starting the loop', async () => {
    const updater = stubUpdater();
    const { connectStdioFn } = stdioOk();

    await main({
      argv: [],
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      connectStdioFn,
      on: vi.fn(),
      exit: vi.fn(),
    });

    expect(updater.start).not.toHaveBeenCalled();
    expect(connectStdioFn).toHaveBeenCalledOnce();
  });

  it('waits for updater shutdown before exiting on a signal', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();
    const stopGate = deferred<void>();
    const stop = vi.fn(() => stopGate.promise);
    const updater = stubUpdater(stop);
    const { connectStdioFn } = stdioOk();

    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      connectStdioFn,
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      exit,
    });

    listeners.get('SIGTERM')?.();
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    stopGate.resolve();
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
      ...stdioOk(),
    });

    expect(log.error).toHaveBeenCalledWith(
      'Failed to start uDDNS MCP server',
      expect.objectContaining({ message: 'invalid config' }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stops the updater when HTTP transport startup fails', async () => {
    const log = silentLog();
    const exit = vi.fn();
    const updater = stubUpdater();

    await main({
      argv: ['--transport=http'],
      env: {},
      log,
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      startHttpFn: async () => {
        throw new Error('listen failed');
      },
      on: vi.fn(),
      exit,
    });

    expect(updater.start).toHaveBeenCalledOnce();
    expect(updater.stop).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to start uDDNS MCP server',
      expect.objectContaining({ message: 'listen failed' }),
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
        ...stdioOk(),
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
      ...stdioOk(),
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
      ...stdioOk(),
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
    const { connectStdioFn } = stdioOk();
    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      connectStdioFn,
    });

    for (const call of onSpy.mock.calls) {
      registered.push(String(call[0]));
      process.removeListener(call[0] as 'SIGINT', call[1] as () => void);
    }
    expect(registered).toEqual(
      expect.arrayContaining(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']),
    );
    expect(connectStdioFn).toHaveBeenCalledOnce();
  });

  it('reads argv and env from the process by default', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'mcp.js', '--check-config'];
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
