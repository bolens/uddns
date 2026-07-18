import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

import { loadAccountsFromFile, runnableAccounts } from '../lib/config-file.js';
import { loadConfig } from '../lib/config.js';
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from '../lib/defaults.js';
import { createMcpSession, getMcpAccount } from '../lib/mcp/session.js';
import { createToolHandlers } from '../lib/mcp/tools.js';
import { createLogger } from '../lib/log.js';
import type { Provider, UpdateResult } from '../lib/schemas/provider.js';
import { createUpdater } from '../lib/updater.js';
import { makeConfig, makeLoadedAccount } from './helpers/config.js';

function mockProvider(
  update: (config: unknown, ip: unknown) => Promise<UpdateResult>,
  id = 'cloudflare',
): Provider {
  return {
    id: id as Provider['id'],
    label: id,
    update: update as Provider['update'],
  };
}

describe('retry configuration', () => {
  it('loads retry defaults', () => {
    const config = loadConfig({
      UDDNS_PROVIDER: 'cloudflare',
      UDDNS_HOSTS: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'tok',
      CLOUDFLARE_ZONE_ID: 'zone',
    });
    expect(config.retryAttempts).toBe(DEFAULT_RETRY_ATTEMPTS);
    expect(config.retryBaseDelayMs).toBe(DEFAULT_RETRY_BASE_DELAY_MS);
    expect(config.retryMaxDelayMs).toBe(DEFAULT_RETRY_MAX_DELAY_MS);
  });

  it('accepts valid retry env overrides', () => {
    const config = loadConfig({
      UDDNS_PROVIDER: 'cloudflare',
      UDDNS_HOSTS: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'tok',
      CLOUDFLARE_ZONE_ID: 'zone',
      UDDNS_RETRY_ATTEMPTS: '5',
      UDDNS_RETRY_BASE_DELAY_MS: '250',
      UDDNS_RETRY_MAX_DELAY_MS: '5000',
    });
    expect(config.retryAttempts).toBe(5);
    expect(config.retryBaseDelayMs).toBe(250);
    expect(config.retryMaxDelayMs).toBe(5000);
  });

  it('rejects invalid retry attempts', () => {
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'cloudflare',
        UDDNS_HOSTS: 'home.example.com',
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ZONE_ID: 'zone',
        UDDNS_RETRY_ATTEMPTS: '0',
      }),
    ).toThrow(/UDDNS_RETRY_ATTEMPTS/);
  });

  it('rejects max delay below base delay', () => {
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'cloudflare',
        UDDNS_HOSTS: 'home.example.com',
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ZONE_ID: 'zone',
        UDDNS_RETRY_BASE_DELAY_MS: '5000',
        UDDNS_RETRY_MAX_DELAY_MS: '1000',
      }),
    ).toThrow(/greater than or equal/);
  });
});

describe('failover YAML', () => {
  async function writeYaml(body: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-failover-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(file, body, 'utf8');
    return file;
  }

  it('loads primary + failover accounts with retry block', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [home-r53]
    retry:
      attempts: 5
      base_delay_ms: 100
      max_delay_ms: 1000
    cloudflare:
      api_token: tok
      zone_id: zone
  - id: home-r53
    role: failover
    provider: route53
    hosts: [home.example.com]
    route53:
      access_key_id: AKIA
      secret_access_key: secret
      hosted_zone_id: Z123
`);
    const accounts = await loadAccountsFromFile(file);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      id: 'home-cf',
      role: 'primary',
      failoverAccountIds: ['home-r53'],
    });
    expect(accounts[0]!.config.retryAttempts).toBe(5);
    expect(accounts[0]!.config.retryBaseDelayMs).toBe(100);
    expect(accounts[0]!.config.retryMaxDelayMs).toBe(1000);
    expect(accounts[1]).toMatchObject({ id: 'home-r53', role: 'failover', failoverAccountIds: [] });
    expect(runnableAccounts(accounts).map((a) => a.id)).toEqual(['home-cf']);
  });

  it('rejects unknown failover refs', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [missing]
    cloudflare:
      api_token: tok
      zone_id: zone
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/unknown failover account "missing"/);
  });

  it('rejects failover targets that are not role failover', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [other]
    cloudflare:
      api_token: tok
      zone_id: zone
  - id: other
    provider: route53
    hosts: [home.example.com]
    route53:
      access_key_id: AKIA
      secret_access_key: secret
      hosted_zone_id: Z123
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/must have role: failover/);
  });

  it('rejects nested failover on standby accounts', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [home-r53]
    cloudflare:
      api_token: tok
      zone_id: zone
  - id: home-r53
    role: failover
    provider: route53
    hosts: [home.example.com]
    failover: [other]
    route53:
      access_key_id: AKIA
      secret_access_key: secret
      hosted_zone_id: Z123
  - id: other
    role: failover
    provider: duckdns
    hosts: [home]
    duckdns:
      token: tok
      domains: home
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/cannot declare failover targets/);
  });

  it('rejects failover without shared hosts', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [home-r53]
    cloudflare:
      api_token: tok
      zone_id: zone
  - id: home-r53
    role: failover
    provider: route53
    hosts: [other.example.com]
    route53:
      access_key_id: AKIA
      secret_access_key: secret
      hosted_zone_id: Z123
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/share at least one host/);
  });
  it('rejects invalid account roles', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    role: standby
    provider: cloudflare
    hosts: [home.example.com]
    cloudflare:
      api_token: tok
      zone_id: zone
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(
      /role must be "primary" or "failover"/,
    );
  });

  it('rejects invalid failover list entries', async () => {
    const file = await writeYaml(`
version: 1
accounts:
  - id: home-cf
    provider: cloudflare
    hosts: [home.example.com]
    failover: [1]
    cloudflare:
      api_token: tok
      zone_id: zone
`);
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/non-empty account id strings/);
  });
});

describe('updater failover', () => {
  it('does not call secondary when primary succeeds', async () => {
    const primary = vi.fn(async () => ({ ok: true, message: 'primary ok' }));
    const secondary = vi.fn(async () => ({ ok: true, message: 'secondary ok' }));
    const updater = createUpdater({
      config: makeConfig({ hosts: ['home.example.com'], stateFile: null, historyFile: null }),
      provider: mockProvider(primary),
      accountId: 'primary',
      failoverTargets: [
        {
          accountId: 'backup',
          provider: mockProvider(secondary, 'route53'),
          config: makeConfig({
            provider: 'route53',
            hosts: ['home.example.com'],
            stateFile: null,
            historyFile: null,
          }),
        },
      ],
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep: async () => undefined,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('updated');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).not.toHaveBeenCalled();
    expect(result.hostResults?.[0]?.failoverUsed).toBe(false);
  });

  it('fails over after primary failure and records metadata', async () => {
    const primary = vi.fn(async () => ({ ok: false, message: 'primary down' }));
    const secondary = vi.fn(async () => ({ ok: true, message: 'secondary ok' }));
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com'],
        stateFile: null,
        historyFile: null,
        retryAttempts: 1,
      }),
      provider: mockProvider(primary),
      accountId: 'primary',
      failoverTargets: [
        {
          accountId: 'backup',
          provider: mockProvider(secondary, 'route53'),
          config: makeConfig({
            provider: 'route53',
            hosts: ['home.example.com'],
            stateFile: null,
            historyFile: null,
            retryAttempts: 1,
          }),
        },
      ],
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep: async () => undefined,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('updated');
    expect(result.message).toContain('via failover backup');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(result.hostResults?.[0]).toMatchObject({
      providerId: 'route53',
      failoverUsed: true,
      failoverAccountId: 'backup',
    });
  });

  it('fails over after non-retryable auth-style errors', async () => {
    const primary = vi.fn(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const secondary = vi.fn(async () => ({ ok: true, message: 'secondary ok' }));
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com'],
        stateFile: null,
        historyFile: null,
        retryAttempts: 3,
      }),
      provider: mockProvider(primary),
      accountId: 'primary',
      failoverTargets: [
        {
          accountId: 'backup',
          provider: mockProvider(secondary, 'route53'),
          config: makeConfig({
            provider: 'route53',
            hosts: ['home.example.com'],
            stateFile: null,
            historyFile: null,
            retryAttempts: 1,
          }),
        },
      ],
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep: async () => undefined,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('updated');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(result.hostResults?.[0]?.failoverUsed).toBe(true);
  });

  it('reports error when primary and failover both fail', async () => {
    const primary = vi.fn(async () => ({ ok: false, message: 'primary down' }));
    const secondary = vi.fn(async () => ({ ok: false, message: 'secondary down' }));
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com'],
        stateFile: null,
        historyFile: null,
        retryAttempts: 1,
      }),
      provider: mockProvider(primary),
      failoverTargets: [
        {
          accountId: 'backup',
          provider: mockProvider(secondary, 'route53'),
          config: makeConfig({
            provider: 'route53',
            hosts: ['home.example.com'],
            stateFile: null,
            historyFile: null,
            retryAttempts: 1,
          }),
        },
      ],
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep: async () => undefined,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('error');
    expect(result.message).toContain('secondary down');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it('skips secondary when host is not configured there', async () => {
    const primary = vi.fn(async () => ({ ok: false, message: 'primary down' }));
    const secondary = vi.fn(async () => ({ ok: true, message: 'secondary ok' }));
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com'],
        stateFile: null,
        historyFile: null,
        retryAttempts: 1,
      }),
      provider: mockProvider(primary),
      failoverTargets: [
        {
          accountId: 'backup',
          provider: mockProvider(secondary, 'route53'),
          config: makeConfig({
            provider: 'route53',
            hosts: ['other.example.com'],
            stateFile: null,
            historyFile: null,
            retryAttempts: 1,
          }),
        },
      ],
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep: async () => undefined,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('error');
    expect(secondary).not.toHaveBeenCalled();
  });

  it('uses AppConfig retryAttempts when options omit overrides', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'busy', details: { status: 503 } })
      .mockResolvedValueOnce({ ok: true, message: 'ok' });
    const sleep = vi.fn(async () => undefined);
    const updater = createUpdater({
      config: makeConfig({
        hosts: ['home.example.com'],
        stateFile: null,
        historyFile: null,
        retryAttempts: 2,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1,
      }),
      provider: mockProvider(update),
      getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
      sleep,
      random: () => 0,
    });
    const result = await updater.checkOnce({ force: true });
    expect(result.status).toBe('updated');
    expect(update).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });
});

describe('MCP failover accounts', () => {
  it('lists standby accounts and rejects them for live tools', async () => {
    const session = await createMcpSession({
      log: createLogger({ level: 'error' }),
      resolveAccountsFn: () => [
        makeLoadedAccount('home-cf', {
          hosts: ['home.example.com'],
          historyFile: null,
          failoverAccountIds: ['home-r53'],
        }),
        makeLoadedAccount('home-r53', {
          role: 'failover',
          provider: 'route53',
          hosts: ['home.example.com'],
          historyFile: null,
          route53: {
            accessKeyId: 'AKIA',
            secretAccessKey: 'secret',
            hostedZoneId: 'Z123',
          },
        }),
      ],
      getProviderFn: (id) => mockProvider(async () => ({ ok: true, message: 'ok' }), id),
      createUpdaterFn: (options) =>
        createUpdater({
          ...options,
          getPublicIP: async () => ({ v4: '1.2.3.4', v6: null }),
        }),
    });

    expect(session.accounts?.map((a) => a.id)).toEqual(['home-cf']);
    expect(session.standbyAccounts?.map((a) => a.id)).toEqual(['home-r53']);

    const handlers = createToolHandlers(session);
    expect(handlers.listAccounts()).toEqual([
      {
        id: 'home-cf',
        provider: 'cloudflare',
        hosts: ['home.example.com'],
        role: 'primary',
      },
      {
        id: 'home-r53',
        provider: 'route53',
        hosts: ['home.example.com'],
        role: 'failover',
      },
    ]);

    expect(() => getMcpAccount(session, 'home-r53')).toThrow(/failover standby/);
  });
});
