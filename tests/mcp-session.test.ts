import { describe, expect, it } from 'vite-plus/test';

import { createMcpSession } from '../lib/mcp/session.js';
import { createToolHandlers } from '../lib/mcp/tools.js';
import { createUpdater } from '../lib/updater.js';
import { makeConfig } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

describe('mcp session runtime wiring', () => {
  it('creates a runtime-backed session with history resource data', async () => {
    const session = createMcpSession({
      log: silentLog(),
      loadConfigFn: () => makeConfig({ historyFile: null }),
      getProviderFn: () => mockProvider(async () => ({ ok: true, message: 'ok' })),
      createUpdaterFn: ({ config, provider, log }) =>
        createUpdater({
          config,
          provider,
          log,
          getPublicIP: async () => ({ v4: '203.0.113.10', v6: null }),
        }),
    });
    const handlers = createToolHandlers(session);
    expect(await handlers.getHistory()).toEqual({ events: [] });
  });

  it('uses createRuntimeBundle when createUpdaterFn is omitted', () => {
    const session = createMcpSession({
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
  });
});
