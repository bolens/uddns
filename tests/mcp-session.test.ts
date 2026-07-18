import { describe, expect, it } from 'vite-plus/test';

import { createMcpSession } from '../lib/mcp/session.js';
import { createToolHandlers } from '../lib/mcp/tools.js';
import { createUpdater } from '../lib/updater.js';
import { makeConfig, makeLoadedAccount } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

describe('mcp session runtime wiring', () => {
  it('creates a runtime-backed session with history resource data', async () => {
    const session = await createMcpSession({
      log: silentLog(),
      loadConfigFn: () => makeConfig({ historyFile: null }),
      getProviderFn: () => mockProvider(async () => ({ ok: true, message: 'ok' })),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          getPublicIP: async () => ({ v4: '203.0.113.10', v6: null }),
        }),
    });
    const handlers = createToolHandlers(session);
    expect(await handlers.getHistory()).toEqual({ accountId: 'default', events: [] });
    expect(handlers.listAccounts()).toEqual([
      { id: 'default', provider: 'cloudflare', hosts: ['home.example.com'], role: 'primary' },
    ]);
  });

  it('uses createRuntimeBundle when createUpdaterFn is omitted', async () => {
    const session = await createMcpSession({
      log: silentLog(),
      loadConfigFn: () =>
        makeConfig({
          provider: 'duckdns',
          hosts: ['myhost'],
          duckdns: { token: 't', domains: 'myhost' },
          historyFile: null,
        }),
    });
    expect(session.provider.id).toBe('duckdns');
    expect(session.history).toBeNull();
    expect(session.metrics).toBeDefined();
    expect(session.eventListeners).toBeInstanceOf(Set);
    expect(session.accounts).toHaveLength(1);
  });

  it('loads multiple accounts from resolveAccountsFn', async () => {
    const session = await createMcpSession({
      log: silentLog(),
      resolveAccountsFn: () => [
        makeLoadedAccount('a', { hosts: ['a.example.com'], historyFile: null }),
        makeLoadedAccount('b', { hosts: ['b.example.com'], historyFile: null }),
      ],
      getProviderFn: () => mockProvider(async () => ({ ok: true, message: 'ok' })),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          getPublicIP: async () => ({ v4: '203.0.113.10', v6: null }),
        }),
    });
    const handlers = createToolHandlers(session);
    expect(handlers.listAccounts().map((account) => account.id)).toEqual(['a', 'b']);
    expect(handlers.getConfig('b')).toMatchObject({ hosts: ['b.example.com'] });
    expect(handlers.getAccountsStatus().accounts.map((account) => account.id)).toEqual(['a', 'b']);
    expect(() => handlers.getConfig('missing')).toThrow(/Unknown account "missing"/);
  });

  it('rejects empty account lists', async () => {
    await expect(
      createMcpSession({
        log: silentLog(),
        resolveAccountsFn: () => [],
        createUpdaterFn: (options) =>
          createUpdater({
            ...options,
            getPublicIP: async () => ({ v4: null, v6: null }),
          }),
      }),
    ).rejects.toThrow(/No MCP accounts configured/);
  });
});
