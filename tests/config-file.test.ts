import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { loadAccountsFromFile, resolveAccounts } from '../lib/config-file.js';

describe('config-file', () => {
  it('loads multiple accounts from YAML', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: cf
    provider: cloudflare
    hosts: [home.example.com]
    cloudflare:
      api_token: token
      zone_id: zone
      proxied: false
      ttl: 1
      create_if_missing: true
      record_id: pinned-record
  - id: duck
    provider: duckdns
    hosts: [myhost]
    duckdns:
      token: duck-token
      domains: [myhost, other]
    ip_https_v4: [https://ipv4.example.test]
    ip_timeout_ms: 2500
  - id: r53
    provider: route53
    hosts: [home.example.com]
    route53:
      access_key_id: AKIAtest
      secret_access_key: secret
      hosted_zone_id: Z123
      region: us-west-2
      ttl: 300
      create_if_missing: false
  - id: pb
    provider: porkbun
    hosts: [home.example.com]
    porkbun:
      api_key: key
      secret_key: secret
      domain: example.com
  - id: hz
    provider: hetzner
    hosts: [home.example.com]
    hetzner:
      api_token: token
      zone_name: example.com
  - id: do
    provider: digitalocean
    hosts: [home.example.com]
    digitalocean:
      api_token: token
      domain: example.com
  - id: gandi
    provider: gandi
    hosts: [home.example.com, vpn.example.com]
    disabled_hosts: [vpn.example.com]
    gandi:
      api_token: token
      domain: example.com
      ttl: 300
  - id: linode
    provider: linode
    hosts: [home.example.com]
    linode:
      api_token: token
      domain_id: 42
      domain: example.com
  - id: ovh
    provider: ovh
    hosts: [home.example.com]
    ovh:
      endpoint: eu
      application_key: ak
      application_secret: as
      consumer_key: ck
      zone: example.com
  - id: bunny
    provider: bunny
    hosts: [home.example.com]
    bunny:
      api_key: key
      zone_id: 7
      domain: example.com
  - id: contabo
    provider: contabo
    hosts: [home.example.com]
    contabo:
      client_id: cid
      client_secret: csec
      api_user: user
      api_password: pass
      zone: example.com
  - id: nc
    provider: namecheap
    hosts: [home]
    namecheap:
      host: home
      domain: example.com
      password: pass
  - id: dyn
    provider: dyndns
    hosts: [host.example.com]
    user: user
    pass: pass
    dyndns:
      update_url: https://example.com/nic/update
`,
    );

    const accounts = await loadAccountsFromFile(file, {});
    expect(accounts).toHaveLength(13);
    expect(accounts.map((account) => account.config.provider)).toEqual([
      'cloudflare',
      'duckdns',
      'route53',
      'porkbun',
      'hetzner',
      'digitalocean',
      'gandi',
      'linode',
      'ovh',
      'bunny',
      'contabo',
      'namecheap',
      'dyndns',
    ]);
    expect(accounts[0]?.config.stateFile).toContain('uddns-state-cf');
    expect(accounts.find((account) => account.id === 'gandi')?.config.disabledHosts).toEqual([
      'vpn.example.com',
    ]);
    expect(accounts.find((account) => account.id === 'r53')?.config.route53.createIfMissing).toBe(
      false,
    );
    expect(accounts.find((account) => account.id === 'cf')?.config.cloudflare.recordId).toBe(
      'pinned-record',
    );
    expect(accounts.find((account) => account.id === 'duck')?.config.duckdns.domains).toBe(
      'myhost,other',
    );
    expect(accounts.find((account) => account.id === 'duck')?.config.ipHttpsV4).toEqual([
      'https://ipv4.example.test',
    ]);
    expect(accounts.find((account) => account.id === 'duck')?.config.ipTimeoutMs).toBe(2500);
  });

  it('resolveAccounts falls back to single-env config', () => {
    const accounts = resolveAccounts({
      UDDNS_PROVIDER: 'duckdns',
      UDDNS_HOSTS: 'myhost',
      DUCKDNS_TOKEN: 'token',
    }) as Array<{ id: string; config: { provider: string } }>;
    expect(accounts).toEqual([
      expect.objectContaining({
        id: 'default',
        config: expect.objectContaining({ provider: 'duckdns' }),
      }),
    ]);
  });

  it('resolveAccounts reads UDDNS_CONFIG_FILE', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'one.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: only
    provider: duckdns
    hosts: [myhost]
    duckdns:
      token: t
      domains: myhost
`,
    );
    const accounts = await resolveAccounts({ UDDNS_CONFIG_FILE: file });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe('only');
  });

  it('applies per-account history defaults when base history env is empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: a
    provider: duckdns
    hosts: [myhost]
    duckdns:
      token: t
      domains: myhost
`,
    );
    const accounts = await loadAccountsFromFile(file, { UDDNS_HISTORY_FILE: '' });
    expect(accounts[0]?.config.historyFile).toContain('uddns-history-a');
  });

  it('requires provider and does not inherit managed process env into accounts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: duck
    provider: duckdns
    hosts: [myhost]
    duckdns:
      token: duck-token
      domains: myhost
`,
    );
    const accounts = await loadAccountsFromFile(file, {
      UDDNS_PROVIDER: 'cloudflare',
      UDDNS_HOSTS: 'evil.example.com',
      CLOUDFLARE_API_TOKEN: 'should-not-bleed',
      CLOUDFLARE_ZONE_ID: 'zone-bleed',
    });
    expect(accounts[0]?.config.provider).toBe('duckdns');
    expect(accounts[0]?.config.hosts).toEqual(['myhost']);
    expect(accounts[0]?.config.cloudflare.apiToken).toBeNull();
    expect(accounts[0]?.config.cloudflare.zoneId).toBeNull();

    await writeFile(
      file,
      `
version: 1
accounts:
  - id: missing-provider
    hosts: [myhost]
    duckdns:
      token: t
      domains: myhost
`,
    );
    await expect(loadAccountsFromFile(file, {})).rejects.toThrow(/provider/i);
  });

  it('rejects accounts that share state or history files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: a
    provider: duckdns
    hosts: [a]
    state_file: /tmp/shared-state.json
    duckdns:
      token: t
      domains: a
  - id: b
    provider: duckdns
    hosts: [b]
    state_file: /tmp/shared-state.json
    duckdns:
      token: t
      domains: b
`,
    );
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/share stateFile/);
  });

  it('rejects aliased absolute and relative state paths as duplicates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    const shared = path.join(dir, 'shared-state.json');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: a
    provider: duckdns
    hosts: [a]
    state_file: ${shared}
    duckdns:
      token: t
      domains: a
  - id: b
    provider: duckdns
    hosts: [b]
    state_file: ${path.relative(process.cwd(), shared)}
    duckdns:
      token: t
      domains: b
`,
    );
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/share stateFile/);
  });

  it('rejects duplicate account ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-yaml-'));
    const file = path.join(dir, 'uddns.yaml');
    await writeFile(
      file,
      `
version: 1
accounts:
  - id: same
    provider: duckdns
    hosts: [a]
    state_file: /tmp/state-a.json
    duckdns:
      token: t
      domains: a
  - id: same
    provider: duckdns
    hosts: [b]
    state_file: /tmp/state-b.json
    duckdns:
      token: t
      domains: b
`,
    );
    await expect(loadAccountsFromFile(file)).rejects.toThrow(/Duplicate account id "same"/);
  });
});
