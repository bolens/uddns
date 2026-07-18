import { tmpdir } from 'node:os';
import dns from 'node:dns/promises';

import { describe, expect, it, vi } from 'vite-plus/test';

import { createRuntimeBundle } from '../lib/runtime.js';
import { createUpdater } from '../lib/updater.js';
import { deferred } from './helpers/async.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { makeConfig } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

afterEachRestoreMocks();

describe('createRuntimeBundle', () => {
  it('wires IP policy, notify, and metrics on cycle complete', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [
      { address: '1.1.1.1', family: 4 },
    ]) as unknown as typeof dns.lookup);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const bundle = createRuntimeBundle({
      accountId: 'acct',
      log: silentLog(),
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile: null,
        notifyWebhookUrl: 'https://example.com/hook',
        notifyOn: ['change'],
        ipFamily: 'v4',
        ipMissing: 'clear',
      }),
      getProviderFn: () => mockProvider(update),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: '2001:db8::1' },
            errors: { v4: null, v6: null },
          }),
        }),
    });

    const events: unknown[] = [];
    bundle.eventListeners.add((event) => {
      events.push(event);
    });

    const result = await bundle.updater.checkOnce();
    expect(result.status).toBe('updated');
    expect(result.ip).toEqual({ v4: '203.0.113.10', v6: null });
    expect(bundle.metrics.snapshot().updatesTotal).toBe(1);
    expect(events).toHaveLength(1);
    await bundle.flushNotifications();
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('does not notify on all-skipped unchanged cycles', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const bundle = createRuntimeBundle({
      log: silentLog(),
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile: null,
        notifyWebhookUrl: 'https://example.com/hook',
        notifyOn: ['change'],
      }),
      getProviderFn: () =>
        mockProvider(async () => ({ ok: true, skipped: true, message: 'nochg' })),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: null },
            errors: { v4: null, v6: null },
          }),
        }),
    });

    const result = await bundle.updater.checkOnce();
    expect(result.status).toBe('unchanged');
    await bundle.flushNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bundle.metrics.snapshot().updatesTotal).toBe(0);
    fetchMock.mockRestore();
  });

  it('uses the default discovery resolver when not overridden', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [
      { address: '1.1.1.1', family: 4 },
    ]) as unknown as typeof dns.lookup);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (url.includes('ipv6') || url.includes('api64')) {
        const response = new Response('not-an-ip');
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      const response = new Response('198.51.100.10');
      Object.defineProperty(response, 'url', { value: url });
      return response;
    });
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const bundle = createRuntimeBundle({
      log: silentLog(),
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile: null,
        ipDnsFallback: false,
        ipTimeoutMs: 2000,
      }),
      getProviderFn: () => mockProvider(update),
    });
    const result = await bundle.updater.checkOnce();
    expect(result.ip.v4).toBe('198.51.100.10');
    fetchMock.mockRestore();
  });

  it('appends history and uses custom HTTPS discovery endpoints', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-hist-'));
    const historyFile = path.join(dir, 'history.json');
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const bundle = createRuntimeBundle({
      log: silentLog(),
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile,
        ipHttpsV4: ['https://example.com/v4'],
        ipHttpsV6: ['https://example.com/v6'],
      }),
      getProviderFn: () => mockProvider(update),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: null },
            errors: { v4: null, v6: null },
          }),
        }),
    });

    await bundle.updater.checkOnce();
    expect(await bundle.history?.load()).toHaveLength(1);
  });

  it('supports force and dry-run cycles', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const bundle = createRuntimeBundle({
      log: silentLog(),
      config: makeConfig({ hosts: ['home.example.com'], historyFile: null }),
      getProviderFn: () => mockProvider(update),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: null },
            errors: { v4: null, v6: null },
          }),
        }),
    });

    await bundle.updater.checkOnce();
    update.mockClear();
    const dry = await bundle.updater.checkOnce({ dryRun: true, force: true });
    expect(dry.status).toBe('dry_run');
    expect(update).not.toHaveBeenCalled();

    const forced = await bundle.updater.checkOnce({ force: true });
    expect(forced.status).toBe('updated');
    expect(update).toHaveBeenCalledOnce();
  });

  it('warns when history append fails and still completes the cycle', async () => {
    const log = silentLog();
    const historyFile = `${tmpdir()}/uddns-history-${Date.now()}.json`;
    const bundle = createRuntimeBundle({
      log,
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile,
        ipHttpsV4: ['https://ipv4.example/'],
        ipHttpsV6: ['https://ipv6.example/'],
        notifySlackUrl: 'https://hooks.slack.com/services/T/B/X',
        notifyOn: ['change'],
      }),
      accountId: 'acct',
      getProviderFn: () => mockProvider(async () => ({ ok: true, message: 'ok' })),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: null },
            errors: { v4: null, v6: null },
          }),
        }),
    });
    vi.spyOn(bundle.history!, 'append').mockRejectedValue(new Error('disk full'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await expect(bundle.updater.checkOnce()).resolves.toMatchObject({ status: 'updated' });
    expect(log.warn).toHaveBeenCalledWith(
      'Could not append history',
      expect.objectContaining({ message: expect.stringContaining('disk full') }),
    );
  });

  it('does not block a completed cycle on slow notification delivery', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [
      { address: '1.1.1.1', family: 4 },
    ]) as unknown as typeof dns.lookup);
    const response = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (url.includes('/hook')) {
        return response.promise;
      }
      return Promise.resolve(new Response('ok'));
    });
    const bundle = createRuntimeBundle({
      log: silentLog(),
      config: makeConfig({
        hosts: ['home.example.com'],
        historyFile: null,
        notifyWebhookUrl: 'https://example.com/hook',
        notifyOn: ['change'],
      }),
      getProviderFn: () => mockProvider(async () => ({ ok: true, message: 'ok' })),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          discoverPublicIP: async () => ({
            ip: { v4: '203.0.113.10', v6: null },
            errors: { v4: null, v6: null },
          }),
        }),
    });

    const cycle = bundle.updater.checkOnce();
    const outcome = await Promise.race([
      cycle.then(() => 'completed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);
    expect(outcome).toBe('completed');
    response.resolve(new Response('ok'));
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => {
          const input = call[0];
          const url =
            typeof input === 'string' || input instanceof URL
              ? String(input)
              : input && typeof input === 'object' && 'url' in input
                ? String((input as Request).url)
                : '';
          return url.includes('/hook');
        }),
      ).toBe(true),
    );
    fetchMock.mockRestore();
  });
});
