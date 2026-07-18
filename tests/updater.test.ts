import { describe, expect, it, vi } from 'vite-plus/test';

import type { AppConfig, Provider, PublicIP, UpdateResult } from '../lib/schemas/provider.js';
import { applyIpPolicy } from '../lib/ip-policy.js';
import { createUpdater, isRetryableHttpStatus, summarizeHostResults } from '../lib/updater.js';
import { captureInterval, deferred, flushMicrotasks } from './helpers/async.js';
import { makeConfig } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

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

  it('skips hosts listed in disabledHosts', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'updated' }));
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
        disabledHosts: ['vpn.example.com'],
      }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    const result = await updater.checkOnce();
    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(1);
    const [hostConfig] = update.mock.calls[0] as unknown as [AppConfig, PublicIP];
    expect(hostConfig).toMatchObject({ hostname: 'home.example.com' });
  });

  it('normalizes trailing-dot host selectors in checkOnce', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'updated' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    const result = await updater.checkOnce({ hosts: ['home.example.com.'] });
    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(1);
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

  it('checkpoints successful hosts and retries only failed hosts', async () => {
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
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });

    const second = await updater.checkOnce();
    expect(second.status).toBe('partial');
    expect(update).toHaveBeenCalledTimes(3);
    expect(update.mock.calls[2]?.[0].hostname).toBe('vpn.example.com');

    vpnShouldFail = false;
    const third = await updater.checkOnce();
    expect(third.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(4);
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
  });

  it('does not regress successful hosts after partial when keep restores a prior IP', async () => {
    const update = vi.fn(async (config: AppConfig) => {
      if (config.hostname === 'vpn.example.com') {
        return { ok: false, message: 'badauth' };
      }
      return { ok: true, message: 'ok' };
    });
    let discovered: PublicIP = { v4: '2.2.2.2', v6: null };
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
        ipMissing: 'keep',
      }),
      provider: mockProvider(update),
      getPublicIP: async () => discovered,
      applyIpPolicy: (discoveredIp, previous) =>
        applyIpPolicy(discoveredIp, previous, { family: 'dual', missing: 'keep' }),
      log: silentLog(),
      stateStore: {
        load: async () => ({
          'home.example.com': { v4: '1.1.1.1', v6: null },
          'vpn.example.com': { v4: '1.1.1.1', v6: null },
        }),
        save: async () => {},
      },
    });

    await updater.checkOnce();
    expect(updater.getCurrentIP()).toEqual({ v4: '2.2.2.2', v6: null });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ hostname: 'home.example.com' }),
      { v4: '2.2.2.2', v6: null },
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ hostname: 'vpn.example.com' }),
      { v4: '2.2.2.2', v6: null },
    );

    discovered = { v4: null, v6: null };
    update.mockClear();
    const kept = await updater.checkOnce();
    expect(kept.status).toBe('partial');
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'vpn.example.com' }), {
      v4: '2.2.2.2',
      v6: null,
    });
  });

  it('returns a busy result when a cycle is already in flight', async () => {
    let release: ((result: UpdateResult) => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<UpdateResult>((resolve) => {
          release = resolve;
        }),
    );
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    const first = updater.checkOnceGuarded();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledOnce();
    });
    await expect(updater.checkOnceGuarded()).resolves.toMatchObject({
      status: 'busy',
      message: expect.stringMatching(/still in progress/i),
    });
    release?.({ ok: true, message: 'ok' });
    await expect(first).resolves.toMatchObject({ status: 'updated' });
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
      sleep: async () => {},
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

    expect(result.status).toBe('unchanged');
    expect(result.message).toContain('already up to date');
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
    expect(log.success).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('[home.example.com] [skipped] nochg'),
      undefined,
    );
  });

  it('debug-logs partial discovery errors but proceeds with the available family', async () => {
    const update = vi.fn(async (_config: AppConfig) => ({ ok: true, message: 'ok' }));
    const log = silentLog();
    const onCycleComplete = vi.fn();
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      discoverPublicIP: async () => ({
        ip: { v4: '9.9.9.9', v6: null },
        errors: { v4: null, v6: { message: 'no ipv6 route' } },
      }),
      log,
      onCycleComplete,
    });

    const result = await updater.checkOnce();

    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledOnce();
    expect(log.debug).toHaveBeenCalledWith(
      'Partial public IP discovery',
      expect.objectContaining({ ipv6Error: expect.objectContaining({ message: 'no ipv6 route' }) }),
    );
    expect(onCycleComplete).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryErrors: { v4: false, v6: true } }),
    );
  });

  it('starts and stops the interval loop with the configured delay', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const { timers, setIntervalFn, clearIntervalFn, clear } = captureInterval();

    const updater = createUpdater({
      config: makeConfig({ interval: 90_000, hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      setIntervalFn,
      clearIntervalFn,
    });

    const handle = await updater.start();
    expect(timers).toEqual([{ fn: expect.any(Function), delay: 90_000 }]);
    expect(update).toHaveBeenCalledOnce();

    const firstTimer = timers[0];
    expect(firstTimer).toBeDefined();
    firstTimer!.fn();
    expect(update).toHaveBeenCalledOnce();

    await handle.stop();
    expect(clear).toHaveBeenCalledWith(1);
  });

  it('skips interval ticks while a previous cycle is still in flight', async () => {
    const { timers, setIntervalFn, clearIntervalFn } = captureInterval();
    const log = silentLog();

    let ipCounter = 0;
    let updateCalls = 0;
    const pending = deferred<UpdateResult>();
    const update = vi.fn((): Promise<UpdateResult> => {
      updateCalls += 1;
      if (updateCalls === 1) {
        return Promise.resolve({ ok: true, message: 'ok' });
      }
      return pending.promise;
    });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      // Every discovery returns a fresh IP so each cycle attempts an update.
      getPublicIP: async () => {
        ipCounter += 1;
        return { v4: `203.0.113.${ipCounter}`, v6: null };
      },
      log,
      setIntervalFn,
      clearIntervalFn,
    });

    await updater.start();
    expect(update).toHaveBeenCalledTimes(1);

    const tick = timers[0]!.fn;

    // Second cycle starts and hangs on the provider call.
    tick();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(2);
    });

    // Further ticks while the cycle is in flight are skipped with a warning.
    tick();
    tick();
    await flushMicrotasks();
    expect(update).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('previous cycle still in progress'),
      expect.anything(),
    );

    // Once the slow cycle finishes, the next tick runs normally again.
    pending.resolve({ ok: true, message: 'ok' });
    await flushMicrotasks();
    tick();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(3);
    });
  });

  it('logs interval cycle failures instead of leaving rejections unhandled', async () => {
    const { timers, setIntervalFn, clearIntervalFn } = captureInterval();
    const log = silentLog();
    let discoveries = 0;

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(async () => ({ ok: true, message: 'ok' })),
      discoverPublicIP: async () => {
        discoveries += 1;
        if (discoveries > 1) {
          throw new Error('discovery exploded');
        }
        return { ip: { v4: '203.0.113.1', v6: null }, errors: { v4: null, v6: null } };
      },
      log,
      setIntervalFn,
      clearIntervalFn,
    });

    await updater.start();

    timers[0]!.fn();
    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(
        'Check cycle failed',
        expect.objectContaining({ message: 'discovery exploded' }),
      );
    });
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
      await handle.stop();

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(expected));
    }
  });

  it('retries failed results that carry retryable HTTP statuses in their details', async () => {
    const delays: number[] = [];
    const update = vi
      .fn<Provider['update']>()
      .mockResolvedValueOnce({
        ok: false,
        message: 'server error',
        details: { results: [{ details: { http: { status: 503 } } }] },
      })
      .mockResolvedValueOnce({
        ok: false,
        message: 'rate limited',
        details: { httpStatus: 429 },
      })
      .mockResolvedValue({ ok: true, message: 'ok' });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(update).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('honors Retry-After delays from failed provider results', async () => {
    const delays: number[] = [];
    const update = vi
      .fn<Provider['update']>()
      .mockResolvedValueOnce({
        ok: false,
        message: 'rate limited',
        details: { httpStatus: 429, retryAfterMs: 2500 },
      })
      .mockResolvedValue({ ok: true, message: 'ok' });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
      retryMaxDelayMs: 10_000,
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(delays).toEqual([2500]);
  });

  it('clamps server Retry-After to retryMaxDelayMs', async () => {
    const delays: number[] = [];
    const update = vi
      .fn<Provider['update']>()
      .mockResolvedValueOnce({
        ok: false,
        message: 'rate limited',
        details: { httpStatus: 429, retryAfterMs: 60_000 },
      })
      .mockResolvedValue({ ok: true, message: 'ok' });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
      retryMaxDelayMs: 30_000,
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(delays).toEqual([30_000]);
  });

  it('refreshes currentIP from enabled-host checkpoints when some hosts are disabled', async () => {
    const store = {
      load: async () => ({
        'home.example.com': { v4: '9.9.9.9' as string | null, v6: null as string | null },
      }),
      save: async () => {},
    };
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com', 'vpn.example.com'],
        disabledHosts: ['vpn.example.com'],
      }),
      provider: mockProvider(async () => ({ ok: true, message: 'ok', skipped: true })),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      stateStore: store,
    });

    await updater.checkOnce();
    expect(updater.getCurrentIP()).toEqual({ v4: '9.9.9.9', v6: null });
  });

  it('does not retry non-retryable failed results or errors', async () => {
    const sleep = vi.fn(async () => {});

    const badauth = vi.fn<Provider['update']>().mockResolvedValue({
      ok: false,
      message: 'badauth',
      details: { httpStatus: 401 },
    });
    const authUpdater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(badauth),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep,
    });
    await expect(authUpdater.checkOnce()).resolves.toMatchObject({ status: 'error' });
    expect(badauth).toHaveBeenCalledOnce();

    const typeError = vi.fn<Provider['update']>().mockRejectedValue(new TypeError('bug'));
    const bugUpdater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(typeError),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep,
    });
    await expect(bugUpdater.checkOnce()).resolves.toMatchObject({ status: 'error' });
    expect(typeError).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns the last failed result once retry attempts are exhausted', async () => {
    const update = vi.fn<Provider['update']>().mockResolvedValue({
      ok: false,
      message: 'still down',
      details: { httpStatus: 502 },
    });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async () => {},
      retryAttempts: 2,
    });

    const result = await updater.checkOnce();
    expect(result.status).toBe('error');
    expect(update).toHaveBeenCalledTimes(2);
    expect(result.hostResults?.[0]?.result.message).toBe('still down');
  });

  it('retries HttpError and status-carrying thrown errors', async () => {
    const { HttpError } = await import('../lib/providers/http.js');
    const update = vi
      .fn<Provider['update']>()
      .mockRejectedValueOnce(new HttpError('socket closed'))
      .mockRejectedValueOnce(Object.assign(new Error('cf 500'), { status: 500 }))
      .mockResolvedValue({ ok: true, message: 'ok' });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      // No injected sleep: exercises the real setTimeout-based delay with a tiny budget.
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('warns and continues when state loading or saving fails', async () => {
    const log = silentLog();
    const update = vi.fn(async (_config: AppConfig) => ({ ok: true, message: 'ok' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log,
      stateStore: {
        load: async () => {
          throw new Error('corrupt state');
        },
        save: async () => {
          throw new Error('disk full');
        },
      },
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not load updater state'),
      expect.objectContaining({ message: 'corrupt state' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Could not persist updater state',
      expect.objectContaining({ message: 'disk full' }),
    );
  });

  it('retries transient transport failures with exponential jittered backoff', async () => {
    const delays: number[] = [];
    const update = vi
      .fn<Provider['update']>()
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValue({ ok: true, message: 'ok' });

    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => 0.5,
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(update).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('loads and persists per-host checkpoints', async () => {
    const save = vi.fn(async () => {});
    const update = vi.fn(async (_config: AppConfig) => ({ ok: true, message: 'ok' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com', 'vpn.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      stateStore: {
        load: async () => ({ 'home.example.com': { v4: '9.9.9.9', v6: null } }),
        save,
      },
    });

    await expect(updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0].hostname).toBe('vpn.example.com');
    expect(save).toHaveBeenCalledWith({
      'home.example.com': { v4: '9.9.9.9', v6: null },
      'vpn.example.com': { v4: '9.9.9.9', v6: null },
    });
  });

  it('waits for an active cycle during graceful shutdown', async () => {
    let release: ((result: UpdateResult) => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<UpdateResult>((resolve) => {
          release = resolve;
        }),
    );
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
    });

    const startPromise = updater.start();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledOnce();
    });
    const stopPromise = updater.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release?.({ ok: true, message: 'ok' });
    await Promise.all([startPromise, stopPromise]);
    expect(stopped).toBe(true);
  });

  it('does not leave a timer running when stop overlaps start', async () => {
    const { setIntervalFn, clearIntervalFn } = captureInterval();
    let release: ((result: UpdateResult) => void) | undefined;
    let calls = 0;
    const update = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<UpdateResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve({ ok: true, message: 'ok' } satisfies UpdateResult);
    });
    const updater = createUpdater({
      config: makeConfig({ interval: 90_000, hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      setIntervalFn,
      clearIntervalFn,
    });

    const startPromise = updater.start();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledOnce();
    });
    const stopPromise = updater.stop();
    const restartPromise = updater.start();
    release?.({ ok: true, message: 'ok' });
    await Promise.all([startPromise, stopPromise, restartPromise]);

    expect(updater.getStatus().running).toBe(true);
    await updater.stop();
    expect(updater.getStatus().running).toBe(false);
  });

  it('does not mark readiness errors for transient skipped_no_ip', async () => {
    let ip: PublicIP = { v4: '9.9.9.9', v6: null };
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(async () => ({ ok: true, message: 'ok' })),
      getPublicIP: async () => ip,
      log: silentLog(),
    });

    await updater.checkOnce();
    expect(updater.getStatus().lastSuccessAt).not.toBeNull();

    ip = { v4: null, v6: null };
    await updater.checkOnce();
    expect(updater.getStatus().lastCycle?.status).toBe('skipped_no_ip');
    expect(updater.getStatus().lastError).toBeNull();
    expect(updater.getStatus().lastSuccessAt).not.toBeNull();
  });

  it('preserves omitted IP families in checkpoints under IP_MISSING=clear', async () => {
    const update = vi.fn<Provider['update']>(async () => ({
      ok: true,
      skipped: true,
      message: 'unchanged',
    }));
    let discovered: PublicIP = { v4: '9.9.9.9', v6: '2001:db8::9' };
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'], ipMissing: 'clear', ipFamily: 'dual' }),
      provider: mockProvider(update),
      getPublicIP: async () => discovered,
      applyIpPolicy: (next) => ({ v4: next.v4, v6: next.v6 }),
      log: silentLog(),
      stateStore: {
        load: async () => ({}),
        save: async () => {},
      },
    });

    await updater.checkOnce({ force: true });
    expect(updater.getStatus().hosts['home.example.com']).toEqual({
      v4: '9.9.9.9',
      v6: '2001:db8::9',
    });

    discovered = { v4: '9.9.9.9', v6: null };
    update.mockClear();
    await updater.checkOnce();
    expect(update).not.toHaveBeenCalled();
    expect(updater.getStatus().hosts['home.example.com']).toEqual({
      v4: '9.9.9.9',
      v6: '2001:db8::9',
    });
    expect(updater.getCurrentIP().v6).toBe('2001:db8::9');
  });

  it('does not clear lastError or advance lastSuccessAt on dry_run', async () => {
    const update = vi.fn(async () => ({ ok: false, message: 'provider down' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async () => {},
      retryAttempts: 1,
    });

    await updater.checkOnce();
    expect(updater.getStatus().lastError).toMatch(/provider down/);
    const failedAt = updater.getStatus().lastSuccessAt;

    await updater.checkOnce({ dryRun: true });
    expect(updater.getStatus().lastCycle?.status).toBe('dry_run');
    expect(updater.getStatus().lastError).toMatch(/provider down/);
    expect(updater.getStatus().lastSuccessAt).toBe(failedAt);
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not treat dry-run unchanged as readiness success', async () => {
    const update = vi.fn(async () => ({ ok: false, message: 'provider down' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '9.9.9.9', v6: null }),
      log: silentLog(),
      sleep: async () => {},
      retryAttempts: 1,
    });

    // Seed a successful checkpoint, then fail a forced update so lastError is set
    // while the host state still matches the discovered IP.
    update.mockResolvedValueOnce({ ok: true, message: 'updated' });
    await updater.checkOnce();
    update.mockResolvedValueOnce({ ok: false, message: 'provider down' });
    await updater.checkOnce({ force: true });
    expect(updater.getStatus().lastError).toMatch(/provider down/);
    const failedAt = updater.getStatus().lastSuccessAt;

    update.mockClear();
    await updater.checkOnce({ dryRun: true });
    expect(updater.getStatus().lastCycle?.status).toBe('unchanged');
    expect(updater.getStatus().lastCycle?.dryRun).toBe(true);
    expect(updater.getStatus().lastError).toMatch(/provider down/);
    expect(updater.getStatus().lastSuccessAt).toBe(failedAt);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('isRetryableHttpStatus', () => {
  it('treats 429 and 5xx as retryable', () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it('rejects other statuses and non-numbers', () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(499)).toBe(false);
    expect(isRetryableHttpStatus('429')).toBe(false);
    expect(isRetryableHttpStatus(undefined)).toBe(false);
    expect(isRetryableHttpStatus(null)).toBe(false);
  });
});

describe('summarizeHostResults', () => {
  it('commits IP when every host succeeds or any host succeeds (partial)', () => {
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
    const allSkipped = summarizeHostResults(
      ip,
      [
        { host: 'a', result: { ok: true, skipped: true, message: 'nochg' } },
        { host: 'b', result: { ok: true, skipped: true, message: 'nochg' } },
      ],
      commitIP,
    );
    expect(allSkipped.status).toBe('unchanged');
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
    expect(commitIP).toHaveBeenCalledWith(ip);

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
