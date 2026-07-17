import { describe, expect, it, vi } from 'vite-plus/test';

import { main } from '../app.js';
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

describe('application entrypoint', () => {
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

  it('waits for updater shutdown before exiting on a signal', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const exit = vi.fn();
    const stopGate = deferred<void>();
    const stop = vi.fn(() => stopGate.promise);
    const updater = stubUpdater(stop);

    await main({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
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

  it('aggregates multi-account health status', async () => {
    const log = silentLog();
    const updaterA = stubUpdater();
    const updaterB = stubUpdater();
    let calls = 0;
    await main({
      env: { UDDNS_HEALTH: '1', UDDNS_HEALTH_PORT: '0', UDDNS_METRICS: '1' },
      log,
      resolveAccountsFn: () => [
        { id: 'a', config: makeConfig({ hosts: ['a.example.com'] }) },
        { id: 'b', config: makeConfig({ hosts: ['b.example.com'] }) },
      ],
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => {
        calls += 1;
        return calls === 1 ? updaterA : updaterB;
      },
      on: vi.fn(),
      exit: vi.fn(),
    });
    const infoMock = log.info as unknown as { mock: { calls: Array<[string]> } };
    const healthLine = infoMock.mock.calls
      .map((call) => call[0])
      .find((line) => line.includes('Health server listening'));
    const url = String(healthLine).replace('Health server listening on ', '');
    const ready = await (await fetch(`${url}/readyz`)).json();
    expect(ready).toMatchObject({ ok: true, status: { accounts: expect.any(Array) } });
    const events = fetch(`${url}/events`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Closing via shutdown is enough; just ensure the SSE route was hit.
    void events;
  });

  it('starts the health side server and reloads on SIGHUP', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const log = silentLog();
    const updater = stubUpdater();
    const loadConfigFn = vi
      .fn()
      .mockReturnValueOnce(makeConfig({ interval: 900_000 }))
      .mockReturnValue(makeConfig({ interval: 60_000 }));

    await main({
      env: { UDDNS_HEALTH: '1', UDDNS_HEALTH_PORT: '0', UDDNS_METRICS: '1' },
      log,
      loadConfigFn,
      getProviderFn: () => stubProvider,
      createUpdaterFn: () => updater,
      on: (name, listener) => {
        listeners.set(name, listener);
      },
      exit: vi.fn(),
    });

    const infoMock = log.info as unknown as { mock: { calls: Array<[string]> } };
    const healthLine = infoMock.mock.calls
      .map((call) => call[0])
      .find((line) => line.includes('Health server listening'));
    expect(healthLine).toBeTruthy();
    const url = String(healthLine).replace('Health server listening on ', '');
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect((await fetch(`${url}/metrics`)).status).toBe(200);

    listeners.get('SIGHUP')?.();
    await vi.waitFor(() => {
      expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Reloaded'));
    });
    expect(updater.stop).toHaveBeenCalled();
    expect(updater.start).toHaveBeenCalled();
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
