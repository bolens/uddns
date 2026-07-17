import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vite-plus/test';

import { DEFAULT_MCP_HOST, DEFAULT_MCP_PORT, DEFAULT_MCP_TRANSPORT } from '../lib/defaults.js';
import { loadMcpConfig } from '../lib/mcp/config.js';
import { startMcpHttpServer } from '../lib/mcp/http.js';
import { createStderrLogger } from '../lib/mcp/log.js';
import { buildDiagnoseUpdatePrompt, buildSetupProviderPrompt } from '../lib/mcp/prompts.js';
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
});

describe('MCP prompts and resources', () => {
  it('builds setup_provider hints', () => {
    const prompt = buildSetupProviderPrompt('duckdns');
    expect(prompt.messages[0]?.content.text).toContain('DUCKDNS_TOKEN');
    expect(() => buildSetupProviderPrompt('nope')).toThrow(/Unknown provider/);
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
    expect(JSON.parse(history.text)).toEqual({ events: [] });
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
        'force_update',
        'get_config',
        'get_public_ip',
        'get_status',
        'list_providers',
        'set_interval',
        'start_loop',
        'stop_loop',
      ].sort(),
    );
    expect(Object.keys(registered._registeredPrompts).sort()).toEqual(
      ['diagnose_update', 'setup_provider'].sort(),
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
    expect(await registered._registeredTools['start_loop']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(await registered._registeredTools['stop_loop']!.handler(extra)).toMatchObject({
      content: [{ type: 'text' }],
    });

    await registered._registeredPrompts['setup_provider']!.callback({ provider: 'cloudflare' });
    await registered._registeredPrompts['diagnose_update']!.callback();

    await registered._registeredResources[MCP_RESOURCE_URIS.config]!.readCallback(
      new URL(MCP_RESOURCE_URIS.config),
    );
    await registered._registeredResources[MCP_RESOURCE_URIS.publicIp]!.readCallback(
      new URL(MCP_RESOURCE_URIS.publicIp),
    );
    await registered._registeredResources[MCP_RESOURCE_URIS.status]!.readCallback(
      new URL(MCP_RESOURCE_URIS.status),
    );
  });
});

describe('createMcpSession', () => {
  it('loads config and provider through injectable dependencies', () => {
    const session = createMcpSession({
      env: {},
      log: silentLog(),
      loadConfigFn: () => makeConfig(),
      getProviderFn: () => mockProvider(),
      createUpdaterFn: ({ config, provider, log }) =>
        createUpdater({
          config,
          provider,
          log,
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
