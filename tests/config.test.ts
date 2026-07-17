import { describe, expect, it } from 'vite-plus/test';

import { loadConfig } from '../lib/config.js';

describe('loadConfig', () => {
  it('defaults to cloudflare with a 15-minute interval and singular host', () => {
    const config = loadConfig({ DDNS_HOST: 'home.example.com' });
    expect(config.provider).toBe('cloudflare');
    expect(config.interval).toBe(900_000);
    expect(config.hosts).toEqual(['home.example.com']);
    expect(config.hostname).toBe('home.example.com');
  });

  it('parses DDNS_HOSTS into multiple hosts and clears single-host record ids', () => {
    const config = loadConfig({
      DDNS_PROVIDER: 'cloudflare',
      DDNS_HOSTS: 'home.example.com, vpn.example.com, api.example.com',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_RECORD_ID: 'rec-should-be-cleared',
    });

    expect(config.hosts).toEqual(['home.example.com', 'vpn.example.com', 'api.example.com']);
    expect(config.hostname).toBe('home.example.com');
    expect(config.cloudflare.recordId).toBeNull();
  });

  it('accepts DDNS_HOSTNAME as an alias for DDNS_HOST', () => {
    const config = loadConfig({
      DDNS_PROVIDER: 'noip',
      DDNS_INTERVAL: '60000',
      DDNS_HOSTNAME: 'home.example.com',
      DDNS_USER: 'user',
      DDNS_PASS: 'pass',
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
      DDNS_HOST: 'home.example.com',
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
      DDNS_PROVIDER: 'duckdns',
      DUCKDNS_DOMAINS: 'one,two',
      DUCKDNS_TOKEN: 'duck',
    });
    expect(duckdns.hosts).toEqual(['one', 'two']);
    expect(duckdns.duckdns).toEqual({ domains: 'one,two', token: 'duck' });

    const namecheap = loadConfig({
      DDNS_PROVIDER: 'namecheap',
      NAMECHEAP_DOMAIN: 'example.com',
      NAMECHEAP_HOST: 'home',
      NAMECHEAP_PASSWORD: 'ddns',
      DDNS_HOSTS: 'home,vpn',
    });
    expect(namecheap.hosts).toEqual(['home', 'vpn']);
    expect(namecheap.namecheap).toEqual({
      host: 'home',
      domain: 'example.com',
      password: 'ddns',
    });

    const dyndns = loadConfig({
      DDNS_PROVIDER: 'dyndns',
      DDNS_HOST: 'home.example.com',
      DDNS_USER: 'user',
      DDNS_PASS: 'pass',
      DYNDNS_UPDATE_URL: 'https://ddns.example/nic/update',
    });
    expect(dyndns.dyndns).toEqual({
      updateUrl: 'https://ddns.example/nic/update',
      username: 'user',
      password: 'pass',
      hostname: 'home.example.com',
    });
  });

  it('rejects unknown providers, tiny intervals, and missing hosts', () => {
    expect(() => loadConfig({ DDNS_PROVIDER: 'spaceship', DDNS_HOST: 'x.com' })).toThrow(
      /Unsupported[\s\S]*cloudflare/,
    );
    expect(() => loadConfig({ DDNS_HOST: 'x.com', DDNS_INTERVAL: '10' })).toThrow(/DDNS_INTERVAL/);
    expect(() => loadConfig({})).toThrow(/No hosts configured/);
  });
});
