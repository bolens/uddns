import { describe, expect, it, vi } from 'vite-plus/test';

import type { Logger } from '../lib/log.js';
import type { AppConfig, Provider, PublicIP, UpdateResult } from '../lib/schemas/provider.js';
import { createUpdater, summarizeHostResults } from '../lib/updater.js';
import { makeConfig } from './helpers/config.js';

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

function mockProvider(
  update: (config: AppConfig, ip: PublicIP) => Promise<UpdateResult>,
): Provider {
  return {
    id: 'cloudflare',
    label: 'Mock',
    update,
  };
}

describe('createUpdater', () => {
  it('skips when no public IP is available and logs discovery errors', async () => {
    const log = silentLog();
    const update = vi.fn();
    const updater = createUpdater({
      config: makeConfig(),
      provider: mockProvider(update),
      discoverPublicIP: async () => ({
        ip: { v4: null, v6: null },
        errors: {
          v4: { message: 'ipv4 failed', code: 'ETIMEOUT' },
          v6: { message: 'ipv6 failed' },
        },
      }),
      log,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('skipped_no_ip');
    expect(update).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'No public IP available; skipping update.',
      expect.objectContaining({
        ipv4Error: expect.objectContaining({ message: 'ipv4 failed', code: 'ETIMEOUT' }),
        ipv6Error: expect.objectContaining({ message: 'ipv6 failed' }),
      }),
    );
  });

  it('updates every configured host with host-bound config and IP payload', async () => {
    const update = vi.fn(async (config: AppConfig, ip: PublicIP) => ({
      ok: true,
      message: `updated ${config.hostname}`,
      details: { receivedIp: ip.v4 },
    }));
    const log = silentLog();
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
        cloudflare: { apiToken: 'token', zoneId: 'zone', recordId: 'only-single-host' },
      }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(2);
    const firstCall = update.mock.calls[0];
    const secondCall = update.mock.calls[1];
    expect(firstCall?.[0]).toMatchObject({
      hostname: 'home.example.com',
      cloudflare: { recordName: 'home.example.com', recordId: null },
    });
    expect(secondCall?.[0]).toMatchObject({
      hostname: 'vpn.example.com',
      cloudflare: { recordName: 'vpn.example.com', recordId: null },
    });
    expect(firstCall?.[1]).toEqual({ v4: '9.9.9.9', v6: null });
    expect(log.success).toHaveBeenCalledTimes(2);
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
  });

  it('reports unchanged when the IP matches the last successful update', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'updated' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    expect(await updater.checkOnce()).toMatchObject({ status: 'updated' });
    expect(await updater.checkOnce()).toMatchObject({ status: 'unchanged' });
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not advance current IP on partial failure, then retries until all hosts succeed', async () => {
    let vpnShouldFail = true;
    const update = vi.fn(async (config: AppConfig) => {
      if (config.hostname === 'vpn.example.com' && vpnShouldFail) {
        return { ok: false, message: 'badauth' };
      }
      return { ok: true, message: 'ok' };
    });

    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
      }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    const first = await updater.checkOnce();
    expect(first.status).toBe('partial');
    expect(updater.getCurrentIP()).toEqual({ v4: null, v6: null });

    const second = await updater.checkOnce();
    expect(second.status).toBe('partial');
    expect(update).toHaveBeenCalledTimes(4);

    vpnShouldFail = false;
    const third = await updater.checkOnce();
    expect(third.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(6);
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
  });

  it('captures thrown provider errors as host failures without aborting the loop', async () => {
    const update = vi.fn(async (config: AppConfig) => {
      if (config.hostname === 'home.example.com') {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { ok: true, message: 'ok' };
    });
    const log = silentLog();

    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
      }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('partial');
    expect(result.hostResults).toEqual([
      expect.objectContaining({
        host: 'home.example.com',
        result: expect.objectContaining({
          ok: false,
          message: 'socket hang up',
          details: expect.objectContaining({
            error: expect.objectContaining({ message: 'socket hang up', code: 'ECONNRESET' }),
          }),
        }),
      }),
      expect.objectContaining({
        host: 'vpn.example.com',
        result: expect.objectContaining({ ok: true }),
      }),
    ]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('[home.example.com]'),
      expect.objectContaining({ message: 'socket hang up' }),
    );
  });

  it('logs skipped hosts as info and still commits the IP', async () => {
    const update = vi.fn(
      async (): Promise<UpdateResult> => ({ ok: true, skipped: true, message: 'nochg' }),
    );
    const log = silentLog();
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('updated');
    expect(result.message).toContain('already up to date');
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
    expect(log.success).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('[home.example.com] [skipped] nochg'),
      undefined,
    );
  });

  it('debug-logs partial discovery errors but proceeds with the available family', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const log = silentLog();
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      discoverPublicIP: async () => ({
        ip: { v4: '9.9.9.9', v6: null },
        errors: { v4: null, v6: { message: 'no ipv6 route' } },
      }),
      log,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledOnce();
    expect(log.debug).toHaveBeenCalledWith(
      'Partial public IP discovery',
      expect.objectContaining({ ipv6Error: expect.objectContaining({ message: 'no ipv6 route' }) }),
    );
  });

  it('starts and stops the interval loop with the configured delay', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const clear = vi.fn();

    const updater = createUpdater({
      config: makeConfig({ interval: 15_000, hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      setIntervalFn: ((fn: () => void, delay?: number) => {
        timers.push({ fn, delay: delay ?? 0 });
        return 42 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: clear as typeof clearInterval,
    });

    const handle = await updater.start();
    expect(timers).toEqual([{ fn: expect.any(Function), delay: 15_000 }]);
    expect(update).toHaveBeenCalledOnce();

    const firstTimer = timers[0];
    expect(firstTimer).toBeDefined();
    firstTimer!.fn();
    expect(update).toHaveBeenCalledOnce();

    handle.stop();
    expect(clear).toHaveBeenCalledWith(42);
  });

  it('reports the check interval in human units (h/m/s/ms)', async () => {
    const cases: Array<[number, string]> = [
      [7_200_000, '(2h)'],
      [900_000, '(15m)'],
      [15_000, '(15s)'],
      [1_500, '(1500ms)'],
    ];

    for (const [interval, expected] of cases) {
      const log = silentLog();
      const updater = createUpdater({
        config: makeConfig({ interval, hosts: ['home.example.com'] }),
        provider: mockProvider(async () => ({ ok: true, message: 'ok' })),
        getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
        log,
        setIntervalFn: (() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
        clearIntervalFn: (() => {}) as typeof clearInterval,
      });

      const handle = await updater.start();
      handle.stop();

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(expected));
    }
  });
});

describe('summarizeHostResults', () => {
  it('commits IP only when every host succeeds', () => {
    const commitIP = vi.fn();
    const ip = { v4: '1.1.1.1', v6: null };

    const ok = summarizeHostResults(
      ip,
      [
        { host: 'a', result: { ok: true, message: 'good' } },
        { host: 'b', result: { ok: true, skipped: true, message: 'nochg' } },
      ],
      commitIP,
    );
    expect(ok.status).toBe('updated');
    expect(commitIP).toHaveBeenCalledWith(ip);

    commitIP.mockClear();
    const partial = summarizeHostResults(
      ip,
      [
        { host: 'a', result: { ok: true, message: 'good' } },
        { host: 'b', result: { ok: false, message: 'fail' } },
      ],
      commitIP,
    );
    expect(partial.status).toBe('partial');
    expect(commitIP).not.toHaveBeenCalled();

    commitIP.mockClear();
    const failed = summarizeHostResults(
      ip,
      [
        { host: 'a', result: { ok: false, message: 'fail-a' } },
        { host: 'b', result: { ok: false, message: 'fail-b' } },
      ],
      commitIP,
    );
    expect(failed.status).toBe('error');
    expect(failed.message).toContain('fail-a');
    expect(commitIP).not.toHaveBeenCalled();
  });
});
