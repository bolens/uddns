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
    expect(config.stateFile).toBe('.uddns-state.json');
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
      DYNDNS_UPDATE_URL: 'https://ddns.example/nic/update',
    });
    expect(dyndns.dyndns).toEqual({
      updateUrl: 'https://ddns.example/nic/update',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
    });
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
    expect(
      loadConfig({ ...base, DYNDNS_UPDATE_URL: 'https://ddns.example/nic/update' }).dyndns
        .updateUrl,
    ).toBe('https://ddns.example/nic/update');
  });

  it('rejects unknown providers, tiny intervals, and missing hosts', () => {
    expect(() => loadConfig({ UDDNS_PROVIDER: 'spaceship', UDDNS_HOST: 'x.com' })).toThrow(
      /Unsupported[\s\S]*cloudflare/,
    );
    expect(() => loadConfig({ UDDNS_HOST: 'x.com', UDDNS_INTERVAL: '10' })).toThrow(
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
        UDDNS_PROVIDER: 'namecheap',
        UDDNS_HOSTS: 'home',
        NAMECHEAP_PASSWORD: 'ddns',
      }),
    ).toThrow(/NAMECHEAP_DOMAIN \(required when hosts are not FQDNs\)/);
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
  });

  it('rejects malformed booleans, TTLs, hostnames, and managed env typos', () => {
    const base = {
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
    };

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
  });

  it('allows disabling the persisted state file explicitly', () => {
    const config = loadConfig({
      UDDNS_HOST: 'home.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
      UDDNS_STATE_FILE: '',
    });
    expect(config.stateFile).toBeNull();
  });
});
