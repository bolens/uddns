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
  - id: duck
    provider: duckdns
    hosts: [myhost]
    duckdns:
      token: duck-token
      domains: myhost
  - id: r53
    provider: route53
    hosts: [home.example.com]
    route53:
      access_key_id: AKIAtest
      secret_access_key: secret
      hosted_zone_id: Z123
      region: us-west-2
      ttl: 300
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
    expect(accounts).toHaveLength(8);
    expect(accounts.map((account) => account.config.provider)).toEqual([
      'cloudflare',
      'duckdns',
      'route53',
      'porkbun',
      'hetzner',
      'digitalocean',
      'namecheap',
      'dyndns',
    ]);
    expect(accounts[0]?.config.stateFile).toContain('uddns-state-cf');
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
});
