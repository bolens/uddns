import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vite-plus/test';

import { DEFAULT_MCP_HOST, DEFAULT_MCP_PORT, DEFAULT_MCP_TRANSPORT } from '../lib/defaults.js';
import { loadMcpConfig } from '../lib/mcp/config.js';
import { startMcpHttpServer } from '../lib/mcp/http.js';
import { createStderrLogger } from '../lib/mcp/log.js';
import {
  buildDiagnoseUpdatePrompt,
  buildFixConfigPrompt,
  buildSetupProviderPrompt,
} from '../lib/mcp/prompts.js';
import { MCP_RESOURCE_URIS, readMcpResource } from '../lib/mcp/resources.js';
import { createUddnsMcpServer } from '../lib/mcp/server.js';
import { createMcpSession } from '../lib/mcp/session.js';
import { createToolHandlers } from '../lib/mcp/tools.js';
import { loadConfig } from '../lib/schemas/config.js';
import { createUpdater } from '../lib/updater.js';
import { parseTransportOverride } from '../mcp.js';
import { captureInterval } from './helpers/async.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { makeConfig } from './helpers/config.js';
import { silentLog } from './helpers/log.js';
import { mockProvider } from './helpers/provider.js';

afterEachRestoreMocks();

function memoryStateStore() {
  return {
    load: async () => ({}),
    save: async () => {},
  };
}

describe('loadMcpConfig', () => {
  it('uses documented defaults', () => {
    expect(loadMcpConfig({})).toEqual({
      transport: DEFAULT_MCP_TRANSPORT,
      host: DEFAULT_MCP_HOST,
      port: DEFAULT_MCP_PORT,
      authToken: null,
      tlsCert: null,
      tlsKey: null,
    });
  });

  it('requires auth and TLS off loopback for HTTP', () => {
    expect(() =>
      loadMcpConfig({
        UDDNS_MCP_TRANSPORT: 'http',
        UDDNS_MCP_HOST: '0.0.0.0',
      }),
    ).toThrow(/UDDNS_MCP_AUTH_TOKEN/);

    expect(() =>
      loadMcpConfig({
        UDDNS_MCP_TRANSPORT: 'http',
        UDDNS_MCP_HOST: '0.0.0.0',
        UDDNS_MCP_AUTH_TOKEN: 'secret',
      }),
    ).toThrow(/UDDNS_MCP_TLS_CERT/);
  });

  it('accepts transport overrides', () => {
    expect(loadMcpConfig({}, { transportOverride: 'http' }).transport).toBe('http');
  });

  it('rejects invalid transport, port, and half-specified TLS', () => {
    expect(() => loadMcpConfig({ UDDNS_MCP_TRANSPORT: 'udp' })).toThrow(/stdio/);
    expect(() => loadMcpConfig({ UDDNS_MCP_PORT: '0' })).toThrow(/UDDNS_MCP_PORT/);
    expect(() => loadMcpConfig({ UDDNS_MCP_TLS_CERT: '/tmp/cert.pem' })).toThrow(/together/);
  });
});

describe('parseTransportOverride', () => {
  it('parses equals and split forms', () => {
    expect(parseTransportOverride(['--transport=http'])).toBe('http');
    expect(parseTransportOverride(['--transport', 'stdio'])).toBe('stdio');
    expect(parseTransportOverride([])).toBeNull();
    expect(() => parseTransportOverride(['--transport', 'udp'])).toThrow(/stdio/);
  });
});

describe('createStderrLogger', () => {
  it('writes through console.error writers', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createStderrLogger({ level: 'debug' });
    log.info('hello');
    log.debug('dbg');
    log.warn('warn');
    log.error('err');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('MCP tool handlers', () => {
  it('redacts secrets from get_config and runs guarded check_once', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const config = makeConfig({
      cloudflare: { apiToken: 'super-secret-token', zoneId: 'zone' },
    });
    const updater = createUpdater({
      config,
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const handlers = createToolHandlers(
      {
        config,
        provider: mockProvider(update),
        updater,
        log: silentLog(),
      },
      {
        discoverPublicIPFn: async () => ({
          ip: { v4: '9.9.9.9', v6: null },
          errors: { v4: null, v6: null },
        }),
      },
    );

    const redacted = handlers.getConfig() as { cloudflare: { apiToken: unknown } };
    expect(JSON.stringify(redacted)).not.toContain('super-secret-token');
    expect(redacted.cloudflare.apiToken).toBe('[redacted]');

    expect(handlers.listProviders().some((provider) => provider.id === 'cloudflare')).toBe(true);
    expect(await handlers.getPublicIp()).toMatchObject({ ip: { v4: '9.9.9.9' } });

    const result = await handlers.checkOnce();
    expect(result?.status).toBe('updated');
    expect(handlers.getStatus().cycle).toBe(1);
  });

  it('redacts bearer tokens from MCP toolResult payloads', async () => {
    const update = vi.fn(async () => ({
      ok: false,
      message: 'provider rejected',
      details: {
        authorization: 'Bearer super-secret-token',
        http: { bodyPreview: 'Bearer leaked-token xyz' },
      },
    }));
    const config = makeConfig();
    const updater = createUpdater({
      config,
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    await updater.checkOnce();

    const server = createUddnsMcpServer({
      config,
      provider: mockProvider(update),
      updater,
      log: silentLog(),
    });
    try {
      const registered = server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra?: unknown) => Promise<unknown> }
        >;
      };
      const payload = await registered._registeredTools['get_status']!.handler({});
      const text = JSON.stringify(payload);
      expect(text).not.toContain('super-secret-token');
      expect(text).not.toContain('leaked-token');
      expect(text).toContain('[redacted]');
    } finally {
      server.dispose();
    }
  });

  it('starts, retunes interval, and restarts after stop', async () => {
    const { timers, setIntervalFn, clearIntervalFn } = captureInterval();
    const updater = createUpdater({
      config: makeConfig({ interval: 15_000 }),
      provider: mockProvider(async () => ({ ok: true, message: 'ok' })),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      setIntervalFn,
      clearIntervalFn,
      stateStore: memoryStateStore(),
    });
    const handlers = createToolHandlers({
      config: makeConfig(),
      provider: mockProvider(),
      updater,
      log: silentLog(),
    });

    await handlers.startLoop();
    expect(handlers.getStatus().running).toBe(true);
    expect(timers[0]?.delay).toBe(15_000);

    handlers.setInterval(30_000);
    expect(handlers.getStatus().intervalMs).toBe(30_000);
    expect(timers.at(-1)?.delay).toBe(30_000);

    await handlers.stopLoop();
    expect(handlers.getStatus().running).toBe(false);

    await handlers.startLoop();
    expect(handlers.getStatus().running).toBe(true);
  });

  it('starts and stops every account when accountId is omitted', async () => {
    const updaterA = createUpdater({
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const updaterB = createUpdater({
      config: makeConfig({ hosts: ['b.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const handlers = createToolHandlers({
      accountId: 'a',
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      updater: updaterA,
      log: silentLog(),
      accounts: [
        {
          id: 'a',
          config: makeConfig({ hosts: ['a.example.com'] }),
          provider: mockProvider(),
          updater: updaterA,
        },
        {
          id: 'b',
          config: makeConfig({ hosts: ['b.example.com'] }),
          provider: mockProvider(),
          updater: updaterB,
        },
      ],
    });

    expect(await handlers.startLoop()).toMatchObject({
      accounts: [{ id: 'a' }, { id: 'b' }],
    });
    expect(updaterA.getStatus().running).toBe(true);
    expect(updaterB.getStatus().running).toBe(true);
    expect(handlers.getAccountsConfig().accounts).toHaveLength(2);
    expect(await handlers.getAccountsHistory()).toMatchObject({
      accounts: [{ accountId: 'a' }, { accountId: 'b' }],
    });

    expect(await handlers.stopLoop()).toMatchObject({
      accounts: [{ id: 'a' }, { id: 'b' }],
    });
    expect(updaterA.getStatus().running).toBe(false);
    expect(updaterB.getStatus().running).toBe(false);

    expect(handlers.setInterval(45_000)).toMatchObject({
      accounts: [
        { id: 'a', status: expect.objectContaining({ intervalMs: 45_000 }) },
        { id: 'b', status: expect.objectContaining({ intervalMs: 45_000 }) },
      ],
    });
    expect(updaterA.getStatus().intervalMs).toBe(45_000);
    expect(updaterB.getStatus().intervalMs).toBe(45_000);

    await handlers.startLoop('b');
    expect(updaterA.getStatus().running).toBe(false);
    expect(updaterB.getStatus().running).toBe(true);
    await handlers.stopLoop('b');

    await updaterA.stop();
    await updaterB.stop();
  });

  it('validates config, explains cycles, lists accounts, and updates hosts', async () => {
    const update = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const config = makeConfig({
      hosts: ['home.example.com', 'vpn.example.com'],
      cloudflare: { apiToken: 'tok', zoneId: 'zone' },
    });
    const updater = createUpdater({
      config,
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const handlers = createToolHandlers({
      config,
      provider: mockProvider(update),
      updater,
      log: silentLog(),
      history: {
        load: async () => [
          {
            at: '2026-01-01T00:00:00.000Z',
            status: 'error',
            ip: { v4: null, v6: null },
            message: 'provider failed',
            durationMs: 1,
            cycle: 1,
          },
        ],
        append: async (event) => [event],
      },
    });

    expect(handlers.listAccounts()).toEqual([
      {
        id: 'default',
        provider: 'cloudflare',
        hosts: ['home.example.com', 'vpn.example.com'],
      },
    ]);
    expect(handlers.validateConfig()).toMatchObject({
      valid: true,
      accountId: 'default',
      provider: 'cloudflare',
    });
    expect(handlers.getAccountsStatus().accounts).toHaveLength(1);
    expect(await handlers.getHistory()).toMatchObject({
      accountId: 'default',
      events: [expect.objectContaining({ status: 'error' })],
    });
    expect(await handlers.explainLastCycle()).toMatchObject({
      severity: 'error',
      nextSteps: expect.arrayContaining([expect.stringContaining('provider credentials')]),
    });

    const dry = await handlers.updateHosts(['home.example.com'], { dryRun: true });
    expect(dry?.status).toBe('dry_run');
    expect(update).not.toHaveBeenCalled();

    const invalid = createToolHandlers({
      config: makeConfig({ provider: 'gandi', gandi: { apiToken: null, domain: null } }),
      provider: mockProvider(),
      updater,
      log: silentLog(),
    });
    expect(invalid.validateConfig().valid).toBe(false);
    expect(invalid.validateConfig().issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(['GANDI_API_TOKEN', 'GANDI_DOMAIN']),
    );

    const empty = createToolHandlers({
      config: makeConfig(),
      provider: mockProvider(),
      updater: createUpdater({
        config: makeConfig(),
        provider: mockProvider(),
        getPublicIP: async () => ({ v4: null, v6: null }),
        log: silentLog(),
        stateStore: memoryStateStore(),
      }),
      log: silentLog(),
    });
    expect(await empty.explainLastCycle()).toMatchObject({
      severity: 'info',
      summary: 'No updater cycle has completed yet',
    });

    for (const [status, severity] of [
      ['skipped_no_ip', 'warning'],
      ['dry_run', 'info'],
      ['partial', 'warning'],
      ['unchanged', 'info'],
    ] as const) {
      const explained = createToolHandlers({
        config: makeConfig(),
        provider: mockProvider(),
        updater: createUpdater({
          config: makeConfig(),
          provider: mockProvider(),
          getPublicIP: async () => ({ v4: null, v6: null }),
          log: silentLog(),
          stateStore: memoryStateStore(),
        }),
        log: silentLog(),
        history: {
          load: async () => [
            {
              at: '2026-01-01T00:00:00.000Z',
              status,
              ip: { v4: null, v6: null },
              message: status,
              durationMs: 1,
              cycle: 1,
            },
          ],
          append: async (event) => [event],
        },
      });
      expect(await explained.explainLastCycle()).toMatchObject({ severity, status });
    }

    const failingUpdater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'] }),
      provider: mockProvider(async () => ({ ok: false, message: 'denied' })),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    await failingUpdater.checkOnce();
    const liveExplain = createToolHandlers({
      config: makeConfig(),
      provider: mockProvider(),
      updater: failingUpdater,
      log: silentLog(),
    });
    expect(await liveExplain.explainLastCycle()).toMatchObject({
      severity: 'error',
      failedHosts: [{ host: 'home.example.com', message: 'denied' }],
    });
  });
});

describe('MCP prompts and resources', () => {
  it('builds setup_provider hints', () => {
    const prompt = buildSetupProviderPrompt('duckdns');
    expect(prompt.messages[0]?.content.text).toContain('DUCKDNS_TOKEN');
    expect(() => buildSetupProviderPrompt('nope')).toThrow(/Unknown provider/);
  });

  it('builds fix_config from validation issues', () => {
    const prompt = buildFixConfigPrompt({
      config: makeConfig({
        provider: 'bunny',
        bunny: { apiKey: null, zoneId: null, domain: null },
      }),
      provider: mockProvider(),
      updater: createUpdater({
        config: makeConfig(),
        provider: mockProvider(),
        getPublicIP: async () => ({ v4: null, v6: null }),
        log: silentLog(),
        stateStore: memoryStateStore(),
      }),
      log: silentLog(),
    });
    expect(prompt.messages[0]?.content.text).toContain('BUNNY_API_KEY');
    expect(prompt.description).toContain('configuration patch');
  });

  it('builds diagnose_update from live session data', async () => {
    const config = makeConfig({ cloudflare: { apiToken: 'tok', zoneId: 'z' } });
    const updater = createUpdater({
      config,
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '8.8.8.8', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const prompt = await buildDiagnoseUpdatePrompt({
      config,
      provider: mockProvider(),
      updater,
      log: silentLog(),
    });
    expect(prompt.messages[0]?.content.text).toContain('Diagnose a uDDNS update');
    expect(prompt.messages[0]?.content.text).not.toContain('super-secret');
  });

  it('includes discovery errors in diagnose_update when IP lookup fails', async () => {
    const prompt = await buildDiagnoseUpdatePrompt(
      {
        config: makeConfig(),
        provider: mockProvider(),
        updater: createUpdater({
          config: makeConfig(),
          provider: mockProvider(),
          getPublicIP: async () => ({ v4: null, v6: null }),
          log: silentLog(),
          stateStore: memoryStateStore(),
        }),
        log: silentLog(),
      },
      {
        discoverPublicIPFn: async () => {
          throw new Error('dns down');
        },
      },
    );
    expect(prompt.messages[0]?.content.text).toContain('dns down');
  });

  it('reads uddns:// resources', async () => {
    const config = makeConfig({ cloudflare: { apiToken: 'tok', zoneId: 'z' } });
    const updater = createUpdater({
      config,
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '8.8.8.8', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const session = {
      config,
      provider: mockProvider(),
      updater,
      log: silentLog(),
    };

    const resource = await readMcpResource(session, MCP_RESOURCE_URIS.config);
    expect(resource.text).not.toContain('"tok"');
    expect(resource.mimeType).toBe('application/json');

    const status = await readMcpResource(session, MCP_RESOURCE_URIS.status);
    const history = await readMcpResource(session, MCP_RESOURCE_URIS.history);
    expect(JSON.parse(history.text)).toEqual({ accountId: 'default', events: [] });
    expect(status.text).toContain('"running"');

    const ip = await readMcpResource(session, MCP_RESOURCE_URIS.publicIp, {
      discoverPublicIPFn: async () => ({
        ip: { v4: '8.8.8.8', v6: null },
        errors: { v4: null, v6: null },
      }),
    });
    expect(ip.text).toContain('8.8.8.8');

    await expect(readMcpResource(session, 'uddns://nope')).rejects.toThrow(/Unknown resource/);
  });

  it('aggregates config and history resources across MCP accounts', async () => {
    const updaterA = createUpdater({
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const updaterB = createUpdater({
      config: makeConfig({ hosts: ['b.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.1.1.1', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const session = {
      accountId: 'a',
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      updater: updaterA,
      log: silentLog(),
      accounts: [
        {
          id: 'a',
          config: makeConfig({ hosts: ['a.example.com'] }),
          provider: mockProvider(),
          updater: updaterA,
          history: null,
        },
        {
          id: 'b',
          config: makeConfig({ hosts: ['b.example.com'] }),
          provider: mockProvider(),
          updater: updaterB,
          history: null,
        },
      ],
    };

    const config = JSON.parse((await readMcpResource(session, MCP_RESOURCE_URIS.config)).text) as {
      accounts: unknown[];
    };
    const history = JSON.parse(
      (await readMcpResource(session, MCP_RESOURCE_URIS.history)).text,
    ) as { accounts: Array<{ accountId: string }> };
    expect(config.accounts).toHaveLength(2);
    expect(history.accounts.map((entry) => entry.accountId)).toEqual(['a', 'b']);
    await updaterA.stop();
    await updaterB.stop();
  });
});

describe('createUddnsMcpServer', () => {
  it('registers and executes tools, prompts, and resources', async () => {
    const config = makeConfig({ cloudflare: { apiToken: 'tok', zoneId: 'z' } });
    const updater = createUpdater({
      config,
      provider: mockProvider(async () => ({ ok: true, message: 'ok' })),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const session = {
      config,
      provider: mockProvider(),
      updater,
      log: silentLog(),
    };
    const server = createUddnsMcpServer(session);

    const registered = server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args?: unknown, extra?: unknown) => Promise<{ content: unknown }> }
      >;
      _registeredPrompts: Record<string, { callback: (args?: unknown) => Promise<unknown> }>;
      _registeredResources: Record<string, { readCallback: (uri: URL) => Promise<unknown> }>;
    };
    expect(Object.keys(registered._registeredTools).sort()).toEqual(
      [
        'check_once',
        'dry_run',
        'explain_last_cycle',
        'force_update',
        'get_config',
        'get_history',
        'get_public_ip',
        'get_status',
        'init_config',
        'list_accounts',
        'list_providers',
        'set_interval',
        'start_loop',
        'stop_loop',
        'update_hosts',
        'validate_config',
      ].sort(),
    );
    expect(Object.keys(registered._registeredPrompts).sort()).toEqual(
      ['diagnose_update', 'fix_config', 'setup_provider'].sort(),
    );
    expect(Object.keys(registered._registeredResources).sort()).toEqual(
      Object.values(MCP_RESOURCE_URIS).sort(),
    );

    const extra = {};
    expect(await registered._registeredTools['list_providers']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['get_config']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['get_status']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['get_public_ip']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(
      await registered._registeredTools['set_interval']!.handler({ intervalMs: 5000 }, extra),
    ).toMatchObject({ content: [{ type: 'text' }] });
    expect(await registered._registeredTools['check_once']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['force_update']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['dry_run']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['list_accounts']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { result: expect.any(Array) },
    });
    expect(await registered._registeredTools['validate_config']!.handler(extra)).toMatchObject({
      structuredContent: { result: expect.objectContaining({ valid: expect.any(Boolean) }) },
    });
    expect(await registered._registeredTools['get_history']!.handler(extra)).toMatchObject({
      structuredContent: { result: expect.objectContaining({ events: expect.any(Array) }) },
    });
    expect(await registered._registeredTools['explain_last_cycle']!.handler(extra)).toMatchObject({
      structuredContent: { result: expect.objectContaining({ summary: expect.any(String) }) },
    });
    expect(
      await registered._registeredTools['update_hosts']!.handler(
        { hosts: ['home.example.com'], dryRun: true },
        extra,
      ),
    ).toMatchObject({
      structuredContent: {
        result: expect.objectContaining({ dryRun: true, status: 'unchanged' }),
      },
    });
    expect(await registered._registeredTools['init_config']!.handler(extra)).toMatchObject({
      structuredContent: {
        result: expect.objectContaining({
          nextSteps: expect.any(Array),
        }),
      },
    });

    const elicit = vi.spyOn(server.server, 'elicitInput');
    elicit.mockResolvedValueOnce({
      action: 'accept',
      content: { provider: 'duckdns', hosts: 'myhost', intervalMs: '60000' },
    });
    expect(await registered._registeredTools['init_config']!.handler(extra)).toMatchObject({
      structuredContent: {
        result: expect.objectContaining({
          env: expect.stringContaining('UDDNS_PROVIDER=duckdns'),
        }),
      },
    });
    elicit.mockResolvedValueOnce({ action: 'cancel' });
    expect(await registered._registeredTools['init_config']!.handler(extra)).toMatchObject({
      structuredContent: { result: expect.objectContaining({ cancelled: true }) },
    });
    elicit.mockResolvedValueOnce({
      action: 'accept',
      content: { provider: 'not-a-provider', hosts: 'x.com' },
    });
    expect(await registered._registeredTools['init_config']!.handler(extra)).toMatchObject({
      structuredContent: {
        result: expect.objectContaining({
          action: 'reject-input',
          error: expect.stringContaining('Unsupported provider'),
        }),
      },
    });

    const sendNotification = vi.fn(async () => {});
    expect(
      await registered._registeredTools['check_once']!.handler(
        {},
        { _meta: { progressToken: 'tok-1' }, sendNotification },
      ),
    ).toMatchObject({ structuredContent: { result: expect.any(Object) } });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'notifications/progress' }),
    );

    expect(await registered._registeredTools['start_loop']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['stop_loop']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });

    await registered._registeredPrompts['setup_provider']!.callback({ provider: 'cloudflare' });
    await registered._registeredPrompts['diagnose_update']!.callback();
    await registered._registeredPrompts['fix_config']!.callback();

    await registered._registeredResources[MCP_RESOURCE_URIS.config]!.readCallback(
      new URL(MCP_RESOURCE_URIS.config),
    );
    await registered._registeredResources[MCP_RESOURCE_URIS.publicIp]!.readCallback(
      new URL(MCP_RESOURCE_URIS.publicIp),
    );
    await registered._registeredResources[MCP_RESOURCE_URIS.status]!.readCallback(
      new URL(MCP_RESOURCE_URIS.status),
    );
    await registered._registeredResources[MCP_RESOURCE_URIS.history]!.readCallback(
      new URL(MCP_RESOURCE_URIS.history),
    );
  });

  it('returns aggregated status for multi-account sessions', async () => {
    const makeUpdater = () =>
      createUpdater({
        config: makeConfig(),
        provider: mockProvider(),
        getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
        log: silentLog(),
        stateStore: memoryStateStore(),
      });
    const primary = makeUpdater();
    const secondary = makeUpdater();
    const server = createUddnsMcpServer({
      accountId: 'a',
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      updater: primary,
      log: silentLog(),
      accounts: [
        {
          id: 'a',
          config: makeConfig({ hosts: ['a.example.com'] }),
          provider: mockProvider(),
          updater: primary,
        },
        {
          id: 'b',
          config: makeConfig({ hosts: ['b.example.com'] }),
          provider: mockProvider(),
          updater: secondary,
        },
      ],
    });
    const registered = server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args?: unknown, extra?: unknown) => Promise<{ structuredContent: unknown }> }
      >;
    };
    expect(await registered._registeredTools['get_status']!.handler({})).toMatchObject({
      structuredContent: {
        result: { accounts: expect.arrayContaining([expect.objectContaining({ id: 'a' })]) },
      },
    });
    expect(
      await registered._registeredTools['get_status']!.handler({ accountId: 'b' }),
    ).toMatchObject({
      structuredContent: {
        result: expect.objectContaining({ running: false }),
      },
    });
  });
});

describe('createMcpSession', () => {
  it('loads config and provider through injectable dependencies', async () => {
    const session = await createMcpSession({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => mockProvider(),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          getPublicIP: async () => ({ v4: null, v6: null }),
          stateStore: memoryStateStore(),
        }),
    });
    expect(session.config.hosts).toEqual(['home.example.com']);
    expect(session.provider.id).toBe('cloudflare');
  });
});

describe('MCP HTTP auth', () => {
  it('answers GET with 405 and DELETE without session with 404', async () => {
    const updater = createUpdater({
      config: makeConfig(),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const eventListeners = new Set<(event: import('../lib/schemas/cycle.js').CycleEvent) => void>();
    const http = await startMcpHttpServer({
      session: {
        config: makeConfig(),
        provider: mockProvider(),
        updater,
        log: silentLog(),
        eventListeners,
      },
      mcpConfig: {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authToken: null,
        tlsCert: null,
        tlsKey: null,
      },
      log: silentLog(),
    });

    try {
      const origin = new URL(http.url).origin;
      expect((await fetch(`${origin}/healthz`)).status).toBe(200);
      expect((await fetch(`${origin}/readyz`)).status).toBe(503);
      const metrics = await fetch(`${origin}/metrics`);
      expect(await metrics.text()).toContain('uddns_cycles_total');
      const events = await fetch(`${origin}/events`);
      expect(events.headers.get('content-type')).toContain('text/event-stream');
      const reader = events.body!.getReader();
      await reader.read();
      for (const listener of eventListeners) {
        listener({
          at: new Date().toISOString(),
          status: 'updated',
          ip: { v4: '1.2.3.4', v6: null },
          message: 'MCP event',
          durationMs: 1,
          cycle: 1,
        });
      }
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('MCP event');
      await reader.cancel();

      const get = await fetch(http.url, { method: 'GET' });
      expect(get.status).toBe(405);

      const del = await fetch(http.url, { method: 'DELETE' });
      expect(del.status).toBe(404);

      const badPost = await fetch(http.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(badPost.status).toBe(400);
    } finally {
      await http.close();
      await updater.stop();
    }
  });

  it('aggregates readyz, metrics, and events across MCP accounts', async () => {
    const listenersA = new Set<(event: import('../lib/schemas/cycle.js').CycleEvent) => void>();
    const listenersB = new Set<(event: import('../lib/schemas/cycle.js').CycleEvent) => void>();
    const updaterA = createUpdater({
      config: makeConfig({ hosts: ['a.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const updaterB = createUpdater({
      config: makeConfig({ hosts: ['b.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const metricsA = {
      snapshot: () => ({
        cyclesTotal: { updated: 1 },
        updatesTotal: 1,
        discoverErrors: 0,
        lastSuccessAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    const metricsB = {
      snapshot: () => ({
        cyclesTotal: { unchanged: 2 },
        updatesTotal: 0,
        discoverErrors: 1,
        lastSuccessAt: '2026-01-02T00:00:00.000Z',
      }),
    };
    const http = await startMcpHttpServer({
      session: {
        accountId: 'a',
        config: makeConfig({ hosts: ['a.example.com'] }),
        provider: mockProvider(),
        updater: updaterA,
        log: silentLog(),
        accounts: [
          {
            id: 'a',
            config: makeConfig({ hosts: ['a.example.com'] }),
            provider: mockProvider(),
            updater: updaterA,
            metrics: metricsA as never,
            eventListeners: listenersA,
          },
          {
            id: 'b',
            config: makeConfig({ hosts: ['b.example.com'] }),
            provider: mockProvider(),
            updater: updaterB,
            metrics: metricsB as never,
            eventListeners: listenersB,
          },
        ],
      },
      mcpConfig: {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authToken: null,
        tlsCert: null,
        tlsKey: null,
      },
      log: silentLog(),
    });

    try {
      const origin = new URL(http.url).origin;
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      expect(metrics).toContain('uddns_cycles_total{status="updated"} 1');
      expect(metrics).toContain('uddns_cycles_total{status="unchanged"} 2');
      expect(metrics).toContain('uddns_discover_errors_total 1');

      const events = await fetch(`${origin}/events`);
      const reader = events.body!.getReader();
      await reader.read();
      for (const listener of listenersB) {
        listener({
          at: new Date().toISOString(),
          status: 'updated',
          ip: { v4: '9.9.9.9', v6: null },
          message: 'from-b',
          durationMs: 1,
          cycle: 2,
        });
      }
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('from-b');
      await reader.cancel();
    } finally {
      await http.close();
      await updaterA.stop();
      await updaterB.stop();
    }
  });

  it('falls back to the primary account when MCP accounts is empty', async () => {
    const updater = createUpdater({
      config: makeConfig({ hosts: ['solo.example.com'] }),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const http = await startMcpHttpServer({
      session: {
        accountId: 'default',
        config: makeConfig({ hosts: ['solo.example.com'] }),
        provider: mockProvider(),
        updater,
        log: silentLog(),
        accounts: [],
        metrics: {
          snapshot: () => ({
            cyclesTotal: {},
            updatesTotal: 0,
            discoverErrors: 0,
            lastSuccessAt: null,
          }),
        } as never,
      },
      mcpConfig: {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authToken: null,
        tlsCert: null,
        tlsKey: null,
      },
      log: silentLog(),
    });

    try {
      const origin = new URL(http.url).origin;
      const ready = (await (await fetch(`${origin}/readyz`)).json()) as { ok: boolean };
      expect(ready.ok).toBe(false);
      expect(await (await fetch(`${origin}/metrics`)).text()).toContain('uddns_updates_total 0');
    } finally {
      await http.close();
      await updater.stop();
    }
  });

  it('rejects missing bearer tokens when auth is configured', async () => {
    const updater = createUpdater({
      config: makeConfig(),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const session = {
      config: makeConfig(),
      provider: mockProvider(),
      updater,
      log: silentLog(),
    };

    const http = await startMcpHttpServer({
      session,
      mcpConfig: {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authToken: 'test-token',
        tlsCert: null,
        tlsKey: null,
      },
      log: silentLog(),
    });

    try {
      const mcpHeaders = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      const initializeBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      });

      const unauthorized = await fetch(http.url, {
        method: 'POST',
        headers: mcpHeaders,
        body: initializeBody,
      });
      expect(unauthorized.status).toBe(401);
      const unauthorizedEvents = await fetch(`${new URL(http.url).origin}/events`);
      expect(unauthorizedEvents.status).toBe(401);
      const unauthorizedMetrics = await fetch(`${new URL(http.url).origin}/metrics`);
      expect(unauthorizedMetrics.status).toBe(401);

      const authorized = await fetch(http.url, {
        method: 'POST',
        headers: {
          ...mcpHeaders,
          authorization: 'Bearer test-token',
        },
        body: initializeBody,
      });
      expect(authorized.status).toBe(200);
      const payload = (await authorized.json()) as { result?: { serverInfo?: { name?: string } } };
      expect(payload.result?.serverInfo?.name).toBe('uddns');
    } finally {
      await http.close();
      await updater.stop();
    }
  });

  it('listens with TLS when cert and key paths are provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uddns-mcp-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        'key.pem',
        '-out',
        'cert.pem',
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
      ],
      { cwd: dir, stdio: 'ignore' },
    );

    const updater = createUpdater({
      config: makeConfig(),
      provider: mockProvider(),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      log: silentLog(),
      stateStore: memoryStateStore(),
    });
    const http = await startMcpHttpServer({
      session: {
        config: makeConfig(),
        provider: mockProvider(),
        updater,
        log: silentLog(),
      },
      mcpConfig: {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authToken: null,
        tlsCert: join(dir, 'cert.pem'),
        tlsKey: join(dir, 'key.pem'),
      },
      log: silentLog(),
    });

    try {
      expect(http.url.startsWith('https://127.0.0.1:')).toBe(true);
      expect(http.httpServer.listening).toBe(true);
    } finally {
      await http.close();
      await updater.stop();
    }
  });
});

describe('managed env allowlist', () => {
  it('accepts UDDNS_MCP_* variables alongside app config', () => {
    expect(() =>
      loadConfig({
        UDDNS_HOSTS: 'home.example.com',
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ZONE_ID: 'zone',
        UDDNS_MCP_TRANSPORT: 'stdio',
        UDDNS_MCP_HOST: '127.0.0.1',
        UDDNS_MCP_PORT: '3923',
        UDDNS_MCP_AUTH_TOKEN: 'secret',
      }),
    ).not.toThrow();
  });
});
