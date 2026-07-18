import { describe, expect, it, vi } from 'vite-plus/test';

import { runOnce } from '../lib/once.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { makeConfig, makeLoadedAccount } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

afterEachRestoreMocks();

function updaterWith(checkOnce: ReturnType<typeof vi.fn>) {
  return {
    checkOnce,
    checkOnceGuarded: checkOnce,
    start: vi.fn(),
    stop: vi.fn(),
    setIntervalMs: vi.fn(),
    getStatus: vi.fn(),
    getCurrentIP: () => ({ v4: null, v6: null }),
  } as never;
}

describe('once', () => {
  it('runs a forced dry-run cycle', async () => {
    const checkOnce = vi.fn(async () => ({
      status: 'dry_run' as const,
      ip: { v4: '203.0.113.10', v6: null },
      message: 'dry',
      dryRun: true,
    }));
    const exit = vi.fn();
    await runOnce({
      force: true,
      dryRun: true,
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => mockProvider(),
      createUpdaterFn: () => updaterWith(checkOnce),
      exit,
    });

    expect(checkOnce).toHaveBeenCalledWith({ force: true, dryRun: true });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits zero on successful updates', async () => {
    const exit = vi.fn();
    await runOnce({
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => mockProvider(),
      createUpdaterFn: () =>
        updaterWith(
          vi.fn(async () => ({
            status: 'updated' as const,
            ip: { v4: '203.0.113.10', v6: null },
            message: 'ok',
          })),
        ),
      exit,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero on error and partial results', async () => {
    for (const status of ['error', 'partial'] as const) {
      const exit = vi.fn();
      await runOnce({
        log: silentLog(),
        loadConfigFn: () => makeConfig(),
        getProviderFn: () => mockProvider(),
        createUpdaterFn: () =>
          updaterWith(
            vi.fn(async () => ({
              status,
              ip: { v4: null, v6: null },
              message: status,
            })),
          ),
        exit,
      });
      expect(exit).toHaveBeenCalledWith(1);
    }
  });

  it('exits non-zero when startup throws', async () => {
    const exit = vi.fn();
    await runOnce({
      log: silentLog(),
      loadConfigFn: () => {
        throw new Error('bad');
      },
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs every account from resolveAccountsFn', async () => {
    const checkOnce = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'updated' as const,
        ip: { v4: '1.1.1.1', v6: null },
        message: 'a ok',
      })
      .mockResolvedValueOnce({
        status: 'partial' as const,
        ip: { v4: '1.1.1.1', v6: null },
        message: 'b partial',
      });
    const exit = vi.fn();
    const log = silentLog();
    await runOnce({
      log,
      resolveAccountsFn: () => [
        makeLoadedAccount('a', { hosts: ['a.example.com'] }),
        makeLoadedAccount('b', { hosts: ['b.example.com'] }),
      ],
      getProviderFn: () => mockProvider(),
      createUpdaterFn: () => updaterWith(checkOnce),
      exit,
    });
    expect(checkOnce).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith('[b] b partial', expect.any(Object));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('rejects empty account lists', async () => {
    const exit = vi.fn();
    await runOnce({
      log: silentLog(),
      resolveAccountsFn: () => [],
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('skips failover standby accounts and only runs primaries', async () => {
    const checkOnce = vi.fn(async () => ({
      status: 'unchanged' as const,
      ip: { v4: '1.1.1.1', v6: null },
      message: 'ok',
    }));
    const exit = vi.fn();
    await runOnce({
      log: silentLog(),
      resolveAccountsFn: () => [
        makeLoadedAccount('primary', {
          hosts: ['home.example.com'],
          failoverAccountIds: ['backup'],
        }),
        makeLoadedAccount('backup', {
          role: 'failover',
          hosts: ['home.example.com'],
          provider: 'route53',
        }),
      ],
      getProviderFn: () => mockProvider(),
      createUpdaterFn: () => updaterWith(checkOnce),
      exit,
    });
    expect(checkOnce).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('uses injected createUpdaterFn through the runtime bundle', async () => {
    const createUpdaterFn = vi.fn(() =>
      updaterWith(
        vi.fn(async () => ({
          status: 'unchanged' as const,
          ip: { v4: '1.1.1.1', v6: null },
          message: 'ok',
        })),
      ),
    );
    const exit = vi.fn();
    await runOnce({
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => mockProvider(),
      createUpdaterFn,
      exit,
    });
    expect(createUpdaterFn).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
