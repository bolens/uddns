import { describe, expect, it, vi } from 'vite-plus/test';

import { runOnce } from '../lib/once.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { makeConfig } from './helpers/config.js';
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
});
