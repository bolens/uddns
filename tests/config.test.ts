import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { loadConfig } from '../lib/config.js';
import { validateProviderConfig } from '../lib/schemas/config.js';
import { makeConfig } from './helpers/config.js';

describe('loadConfig', () => {
  it('defaults to cloudflare with a 15-minute interval and singular host', () => {
    const config = loadConfig({
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
    });
    expect(config.provider).toBe('cloudflare');
    expect(config.interval).toBe(900_000);
    expect(config.stateFile).toBe(path.resolve('.uddns-state.json'));
    expect(config.hosts).toEqual(['home.example.com']);
    expect(config.hostname).toBe('home.example.com');
  });

  it('parses UDDNS_HOSTS into multiple hosts and clears single-host record ids', () => {
    const config = loadConfig({
      UDDNS_PROVIDER: 'cloudflare',
      UDDNS_HOSTS: 'home.example.com, vpn.example.com, api.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_RECORD_ID: 'rec-should-be-cleared',
    });

    expect(config.hosts).toEqual(['home.example.com', 'vpn.example.com', 'api.example.com']);
    expect(config.hostname).toBe('home.example.com');
    expect(config.cloudflare.recordId).toBeNull();
  });

  it('accepts UDDNS_HOSTNAME as an alias for UDDNS_HOST', () => {
    const config = loadConfig({
      UDDNS_PROVIDER: 'noip',
      UDDNS_INTERVAL: '60000',
      UDDNS_HOSTNAME: 'home.example.com',
      UDDNS_USER: 'user',
      UDDNS_PASS: 'pass',
    });

    expect(config).toMatchObject({
      provider: 'noip',
      interval: 60_000,
      hosts: ['home.example.com'],
      user: 'user',
      password: 'pass',
    });
  });

  it('maps provider-specific env vars for cloudflare, duckdns, namecheap, and dyndns', () => {
    const cloudflare = loadConfig({
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ZONE_ID: 'zone-1',
      CLOUDFLARE_RECORD_NAME: 'home.example.com',
      CLOUDFLARE_RECORD_ID: 'rec-1',
      CLOUDFLARE_PROXIED: 'true',
      CLOUDFLARE_TTL: '300',
      CLOUDFLARE_CREATE_IF_MISSING: '0',
    });
    expect(cloudflare.cloudflare).toMatchObject({
      apiToken: 'cf-token',
      zoneId: 'zone-1',
      recordName: 'home.example.com',
      recordId: 'rec-1',
      proxied: true,
      ttl: 300,
      createIfMissing: false,
    });

    const duckdns = loadConfig({
      UDDNS_PROVIDER: 'duckdns',
      DUCKDNS_DOMAINS: 'one,two',
      DUCKDNS_TOKEN: 'duck',
    });
    expect(duckdns.hosts).toEqual(['one', 'two']);
    expect(duckdns.duckdns).toEqual({ domains: 'one,two', token: 'duck' });

    const namecheap = loadConfig({
      UDDNS_PROVIDER: 'namecheap',
      NAMECHEAP_DOMAIN: 'example.com',
      NAMECHEAP_HOST: 'home',
      NAMECHEAP_PASSWORD: 'ddns',
      UDDNS_HOSTS: 'home,vpn',
    });
    expect(namecheap.hosts).toEqual(['home', 'vpn']);
    expect(namecheap.namecheap).toEqual({
      host: 'home',
      domain: 'example.com',
      password: 'ddns',
    });

    const dyndns = loadConfig({
      UDDNS_PROVIDER: 'dyndns',
      UDDNS_HOST: 'home.example.com',
      UDDNS_USER: 'user',
      UDDNS_PASS: 'pass',
      DYNDNS_UPDATE_URL: 'https://members.dyndns.org/nic/update',
    });
    expect(dyndns.dyndns).toEqual({
      updateUrl: 'https://members.dyndns.org/nic/update',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
    });
  });

  it('maps provider-specific env vars for route53, porkbun, hetzner, and digitalocean', () => {
    const route53 = loadConfig({
      UDDNS_PROVIDER: 'route53',
      UDDNS_HOST: 'home.example.com',
      ROUTE53_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      ROUTE53_SECRET_ACCESS_KEY: 'secret',
      ROUTE53_REGION: 'eu-west-1',
      ROUTE53_HOSTED_ZONE_ID: 'Z123',
      ROUTE53_TTL: '60',
      ROUTE53_CREATE_IF_MISSING: 'false',
    });
    expect(route53.route53).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: 'eu-west-1',
      hostedZoneId: 'Z123',
      ttl: 60,
      createIfMissing: false,
    });

    const route53Defaults = loadConfig({
      UDDNS_PROVIDER: 'route53',
      UDDNS_HOST: 'home.example.com',
      ROUTE53_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      ROUTE53_SECRET_ACCESS_KEY: 'secret',
      ROUTE53_HOSTED_ZONE_ID: 'Z123',
    });
    expect(route53Defaults.route53).toMatchObject({
      region: 'us-east-1',
      ttl: 300,
      createIfMissing: true,
    });

    const porkbun = loadConfig({
      UDDNS_PROVIDER: 'porkbun',
      UDDNS_HOSTS: 'home,vpn',
      PORKBUN_API_KEY: 'pk',
      PORKBUN_SECRET_KEY: 'sk',
      PORKBUN_DOMAIN: 'example.com',
    });
    expect(porkbun.porkbun).toEqual({ apiKey: 'pk', secretKey: 'sk', domain: 'example.com' });

    const hetzner = loadConfig({
      UDDNS_PROVIDER: 'hetzner',
      UDDNS_HOST: 'home.example.com',
      HETZNER_API_TOKEN: 'token',
      HETZNER_ZONE_ID: 'zone1',
      HETZNER_ZONE_NAME: 'example.com',
    });
    expect(hetzner.hetzner).toEqual({
      apiToken: 'token',
      zoneId: 'zone1',
      zoneName: 'example.com',
    });

    const digitalocean = loadConfig({
      UDDNS_PROVIDER: 'digitalocean',
      UDDNS_HOST: 'home.example.com',
      DIGITALOCEAN_API_TOKEN: 'token',
      DIGITALOCEAN_DOMAIN: 'example.com',
    });
    expect(digitalocean.digitalocean).toEqual({ apiToken: 'token', domain: 'example.com' });
  });

  it('fails fast on missing credentials for route53, porkbun, hetzner, and digitalocean', () => {
    expect(() => loadConfig({ UDDNS_PROVIDER: 'route53', UDDNS_HOST: 'home.example.com' })).toThrow(
      /ROUTE53_ACCESS_KEY_ID.*ROUTE53_SECRET_ACCESS_KEY.*ROUTE53_HOSTED_ZONE_ID/,
    );
    expect(() => loadConfig({ UDDNS_PROVIDER: 'porkbun', UDDNS_HOST: 'home.example.com' })).toThrow(
      /PORKBUN_API_KEY.*PORKBUN_SECRET_KEY/,
    );
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'porkbun',
        UDDNS_HOSTS: 'home',
        PORKBUN_API_KEY: 'pk',
        PORKBUN_SECRET_KEY: 'sk',
      }),
    ).toThrow(/PORKBUN_DOMAIN \(required for bare labels/);
    expect(() => loadConfig({ UDDNS_PROVIDER: 'hetzner', UDDNS_HOST: 'home.example.com' })).toThrow(
      /HETZNER_API_TOKEN/,
    );
    expect(() =>
      loadConfig({ UDDNS_PROVIDER: 'digitalocean', UDDNS_HOST: 'home.example.com' }),
    ).toThrow(/DIGITALOCEAN_API_TOKEN/);
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'digitalocean',
        UDDNS_HOSTS: 'home',
        DIGITALOCEAN_API_TOKEN: 'token',
      }),
    ).toThrow(/DIGITALOCEAN_DOMAIN \(required for bare labels/);
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'digitalocean',
        UDDNS_HOST: 'example.co.uk',
        DIGITALOCEAN_API_TOKEN: 'token',
      }),
    ).toThrow(/DIGITALOCEAN_DOMAIN \(required for bare labels/);
  });

  it('rejects non-https DYNDNS_UPDATE_URL values', () => {
    const base = {
      UDDNS_PROVIDER: 'dyndns',
      UDDNS_HOST: 'home.example.com',
      UDDNS_USER: 'user',
      UDDNS_PASS: 'pass',
    };

    expect(() =>
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'http://insecure.example/nic/update' }),
    ).toThrow(/DYNDNS_UPDATE_URL must be a valid https/);
    expect(() => loadConfig({ ...base, DYNDNS_UPDATE_URL: 'not a url' })).toThrow(
      /DYNDNS_UPDATE_URL must be a valid https/,
    );
    expect(() =>
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'https://user:pass@ddns.example/nic/update' }),
    ).toThrow(/must not include credentials/);
    expect(() =>
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'https://169.254.169.254/latest/meta-data' }),
    ).toThrow(/must not target loopback, private/);
    expect(() =>
      loadConfig({
        ...base,
        DYNDNS_UPDATE_URL: 'https://[::ffff:169.254.169.254]/latest/meta-data',
      }),
    ).toThrow(/must not target loopback, private/);
    expect(() =>
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'https://ddns.example/nic/update' }),
    ).toThrow(/not allowed/);
    expect(
      loadConfig({
        ...base,
        DYNDNS_UPDATE_URL: 'https://ddns.example/nic/update',
        DYNDNS_UPDATE_URL_ALLOW_HOSTS: 'ddns.example',
      }).dyndns.updateUrl,
    ).toBe('https://ddns.example/nic/update');
    expect(
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'https://members.dyndns.org/nic/update' }).dyndns
        .updateUrl,
    ).toBe('https://members.dyndns.org/nic/update');
  });

  it('rejects unknown providers, tiny intervals, and missing hosts', () => {
    expect(() => loadConfig({ UDDNS_PROVIDER: 'spaceship', UDDNS_HOST: 'x.com' })).toThrow(
      /Unsupported[\s\S]*cloudflare/,
    );
    expect(() => loadConfig({ UDDNS_HOST: 'x.com', UDDNS_INTERVAL: '10' })).toThrow(
      /UDDNS_INTERVAL/,
    );
    expect(() => loadConfig({ UDDNS_HOST: 'x.com', UDDNS_INTERVAL: '2147483648' })).toThrow(
      /UDDNS_INTERVAL/,
    );
    expect(() => loadConfig({})).toThrow(/No hosts configured/);
  });

  it('fails fast on missing provider credentials', () => {
    expect(() =>
      loadConfig({ UDDNS_PROVIDER: 'cloudflare', UDDNS_HOST: 'home.example.com' }),
    ).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(() => loadConfig({ UDDNS_PROVIDER: 'duckdns', UDDNS_HOST: 'home' })).toThrow(
      /DUCKDNS_TOKEN/,
    );
    expect(() => loadConfig({ UDDNS_PROVIDER: 'noip', UDDNS_HOST: 'home.example.com' })).toThrow(
      /UDDNS_USER.*UDDNS_PASS/,
    );
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'dynu',
        UDDNS_USER: 'user',
        UDDNS_HOST: 'home.dynu.com',
      }),
    ).toThrow(/UDDNS_PASS or UDDNS_TOKEN/);
    expect(
      loadConfig({
        UDDNS_PROVIDER: 'dynu',
        UDDNS_USER: 'user',
        UDDNS_TOKEN: 'api-token',
        UDDNS_HOST: 'home.dynu.com',
      }).dyndns.password,
    ).toBe('api-token');
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'dynu',
        UDDNS_USER: 'user',
        CLOUDFLARE_API_TOKEN: 'cf-only',
        UDDNS_HOST: 'home.dynu.com',
      }),
    ).toThrow(/UDDNS_PASS or UDDNS_TOKEN/);
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'dynu',
        UDDNS_USER: 'user',
        DUCKDNS_TOKEN: 'duck-only',
        UDDNS_HOST: 'home.dynu.com',
      }),
    ).toThrow(/UDDNS_PASS or UDDNS_TOKEN/);
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'namecheap',
        UDDNS_HOSTS: 'home',
        NAMECHEAP_PASSWORD: 'ddns',
      }),
    ).toThrow(/NAMECHEAP_DOMAIN \(required for bare labels/);
    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'namecheap',
        UDDNS_HOSTS: 'home.example.co.uk',
        NAMECHEAP_PASSWORD: 'ddns',
      }),
    ).toThrow(/NAMECHEAP_DOMAIN \(required for bare labels/);
    expect(() => loadConfig({ UDDNS_HOST: 'x.com', UDDNS_INTERVAL: 'abc' })).toThrow(
      /UDDNS_INTERVAL/,
    );
  });

  it('validateProviderConfig rejects hand-built configs missing derived fields', () => {
    // These fields are auto-derived by loadConfig, so only direct callers can miss them.
    expect(() =>
      validateProviderConfig(
        makeConfig({ provider: 'cloudflare', cloudflare: { apiToken: 't', recordName: null } }),
      ),
    ).toThrow(/CLOUDFLARE_RECORD_NAME or UDDNS_HOST/);
    expect(() =>
      validateProviderConfig(
        makeConfig({ provider: 'duckdns', duckdns: { token: 't', domains: null } }),
      ),
    ).toThrow(/DUCKDNS_DOMAINS or UDDNS_HOST/);
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'dyndns',
          dyndns: { username: 'u', password: 'p', hostname: null },
        }),
      ),
    ).toThrow(/UDDNS_HOST\(S\)/);

    // Valid configs pass silently.
    expect(() =>
      validateProviderConfig(
        makeConfig({ provider: 'namecheap', namecheap: { password: 'p', domain: 'example.com' } }),
      ),
    ).not.toThrow();
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'noip',
          dyndns: { username: 'u', password: 'p', hostname: 'home.example.com' },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validateProviderConfig(
        makeConfig({ provider: 'gandi', gandi: { apiToken: null, domain: 'example.com' } }),
      ),
    ).toThrow(/GANDI_API_TOKEN/);
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'linode',
          linode: { apiToken: 't', domainId: null, domain: 'example.com' },
        }),
      ),
    ).toThrow(/LINODE_DOMAIN_ID/);
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'ovh',
          ovh: {
            applicationKey: 'a',
            applicationSecret: 's',
            consumerKey: null,
            zone: 'example.com',
          },
        }),
      ),
    ).toThrow(/OVH_CONSUMER_KEY/);
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'bunny',
          bunny: { apiKey: 'k', zoneId: null, domain: 'example.com' },
        }),
      ),
    ).toThrow(/BUNNY_ZONE_ID/);
    expect(() =>
      validateProviderConfig(
        makeConfig({
          provider: 'contabo',
          contabo: {
            clientId: 'c',
            clientSecret: 's',
            apiUser: 'u',
            apiPassword: null,
            zone: 'example.com',
          },
        }),
      ),
    ).toThrow(/CONTABO_API_PASSWORD/);
  });

  it('loads new provider credentials, disabled hosts, chat notify, and otel flags', () => {
    const config = loadConfig({
      UDDNS_PROVIDER: 'ovh',
      UDDNS_HOSTS: 'home.example.com,vpn.example.com',
      UDDNS_DISABLED_HOSTS: 'vpn.example.com',
      UDDNS_NOTIFY_SLACK_URL: 'https://hooks.slack.com/services/T/B/X',
      UDDNS_NOTIFY_DISCORD_URL: 'https://discord.com/api/webhooks/1/2',
      UDDNS_OTEL: '1',
      OVH_ENDPOINT: 'CA',
      OVH_APPLICATION_KEY: 'ak',
      OVH_APPLICATION_SECRET: 'as',
      OVH_CONSUMER_KEY: 'ck',
      OVH_ZONE: 'example.com',
    });
    expect(config).toMatchObject({
      provider: 'ovh',
      disabledHosts: ['vpn.example.com'],
      notifySlackUrl: 'https://hooks.slack.com/services/T/B/X',
      notifyDiscordUrl: 'https://discord.com/api/webhooks/1/2',
      telemetryEnabled: true,
      ovh: { endpoint: 'ca', applicationKey: 'ak', zone: 'example.com' },
    });

    expect(
      loadConfig({
        UDDNS_PROVIDER: 'bunny',
        UDDNS_HOST: 'home.example.com',
        BUNNY_API_KEY: 'key',
        BUNNY_ZONE_ID: '7',
        BUNNY_DOMAIN: 'example.com',
      }).bunny,
    ).toMatchObject({ apiKey: 'key', zoneId: 7, domain: 'example.com' });

    expect(() =>
      loadConfig({
        UDDNS_PROVIDER: 'ovh',
        UDDNS_HOST: 'home.example.com',
        OVH_ENDPOINT: 'not-a-region',
      }),
    ).toThrow(/OVH_ENDPOINT/);

    expect(
      loadConfig({
        UDDNS_PROVIDER: 'gandi',
        UDDNS_HOST: 'home.example.com',
        GANDI_API_TOKEN: 'pat',
        GANDI_DOMAIN: 'example.com',
        GANDI_TTL: '600',
      }).gandi,
    ).toMatchObject({ apiToken: 'pat', domain: 'example.com', ttl: 600 });

    expect(
      loadConfig({
        UDDNS_PROVIDER: 'linode',
        UDDNS_HOST: 'home.example.com',
        LINODE_API_TOKEN: 'tok',
        LINODE_DOMAIN_ID: '99',
        LINODE_DOMAIN: 'example.com',
      }).linode,
    ).toMatchObject({ apiToken: 'tok', domainId: 99, domain: 'example.com' });

    expect(
      loadConfig({
        UDDNS_PROVIDER: 'contabo',
        UDDNS_HOST: 'home.example.com',
        CONTABO_CLIENT_ID: 'cid',
        CONTABO_CLIENT_SECRET: 'csec',
        CONTABO_API_USER: 'user',
        CONTABO_API_PASSWORD: 'pass',
        CONTABO_ZONE: 'example.com',
      }).contabo,
    ).toMatchObject({
      clientId: 'cid',
      apiUser: 'user',
      zone: 'example.com',
    });
  });

  it('rejects malformed booleans, TTLs, hostnames, and managed env typos', () => {
    const base = {
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
    };

    expect(() =>
      loadConfig({ ...base, UDDNS_NOTIFY_SLACK_URL: 'http://hooks.example/slack' }),
    ).toThrow(/UDDNS_NOTIFY_SLACK_URL must be a valid https/);
    expect(() =>
      loadConfig({ ...base, UDDNS_NOTIFY_DISCORD_URL: 'http://discord.example/hook' }),
    ).toThrow(/UDDNS_NOTIFY_DISCORD_URL must be a valid https/);
    expect(() => loadConfig({ ...base, UDDNS_IP_HTTPS_V4: 'http://not-https.example' })).toThrow(
      /IP discovery endpoint must be a valid https/,
    );
    expect(() => loadConfig({ ...base, UDDNS_IP_HTTPS_V4: 'https://127.0.0.1/echo' })).toThrow(
      /must not target loopback, private/,
    );
    expect(() =>
      loadConfig({
        ...base,
        UDDNS_PROVIDER: 'porkbun',
        PORKBUN_API_KEY: 'k',
        PORKBUN_SECRET_KEY: 's',
        PORKBUN_DOMAIN: '../evil.example',
      }),
    ).toThrow(/PORKBUN_DOMAIN must not contain path separators/);
    expect(() =>
      loadConfig({
        ...base,
        UDDNS_NOTIFY_WEBHOOK_URL: 'https://user:pass@hooks.example/hook',
      }),
    ).toThrow(/must not include credentials/);
    // Self-hosted notify on LAN remains allowed; metadata/loopback are not.
    expect(
      loadConfig({ ...base, UDDNS_NOTIFY_NTFY_URL: 'https://10.0.0.5/uddns' }).notifyNtfyUrl,
    ).toBe('https://10.0.0.5/uddns');
    expect(() =>
      loadConfig({ ...base, UDDNS_NOTIFY_NTFY_URL: 'https://169.254.169.254/meta' }),
    ).toThrow(/loopback, link-local, or cloud-metadata/);
    expect(() => loadConfig({ ...base, UDDNS_NOTIFY_SLACK_URL: 'https://10.0.0.5/slack' })).toThrow(
      /loopback, private/,
    );
    expect(() =>
      loadConfig({
        ...base,
        UDDNS_IP_HTTPS_V4: 'https://169.254.169.254.nip.io/ip',
      }),
    ).toThrow(/loopback, private/);

    expect(() => loadConfig({ ...base, CLOUDFLARE_PROXIED: 'treu' })).toThrow(
      /CLOUDFLARE_PROXIED must be one of/,
    );
    expect(() => loadConfig({ ...base, CLOUDFLARE_TTL: '30' })).toThrow(/Cloudflare TTL/);
    expect(() => loadConfig({ ...base, UDDNS_HOST: '-invalid.example.com' })).toThrow(
      /Invalid hostname/,
    );
    expect(() => loadConfig({ ...base, UDDNS_HOST: `${'a'.repeat(254)}.example.com` })).toThrow(
      /Invalid hostname/,
    );
    expect(() => loadConfig({ ...base, UDDNS_HOST: `${'a'.repeat(64)}.example.com` })).toThrow(
      /Invalid hostname/,
    );
    expect(() => loadConfig({ ...base, CLOUDFLARE_API_T0KEN: 'typo' })).toThrow(
      /Unknown uDDNS environment variable.*API_T0KEN/,
    );
    expect(() =>
      loadConfig({
        ...base,
        UDDNS_HEALTH_AUTH_TOKEN: 'health-secret',
      }),
    ).not.toThrow();
  });

  it('allows disabling the persisted state file explicitly', () => {
    const config = loadConfig({
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
      UDDNS_STATE_FILE: '',
    });
    expect(config.stateFile).toBeNull();
  });

  it('rejects state/history paths that escape the data directory', () => {
    expect(() =>
      loadConfig({
        UDDNS_HOST: 'home.example.com',
        CLOUDFLARE_API_TOKEN: 'token',
        UDDNS_DATA_DIR: '/tmp/uddns-data',
        UDDNS_STATE_FILE: '/etc/passwd',
      }),
    ).toThrow(/UDDNS_STATE_FILE must resolve under data directory/);
    expect(() =>
      loadConfig({
        UDDNS_HOST: 'home.example.com',
        CLOUDFLARE_API_TOKEN: 'token',
        UDDNS_DATA_DIR: '/tmp/uddns-data',
        UDDNS_HISTORY_FILE: '../escape.json',
      }),
    ).toThrow(/UDDNS_HISTORY_FILE must resolve under data directory/);
  });
});
