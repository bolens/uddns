import { describe, expect, it } from 'vite-plus/test';

import { bindNamecheapHost, configForHost, parseHostList, resolveHosts } from '../lib/hosts.js';
import { makeConfig } from './helpers/config.js';

describe('parseHostList', () => {
  it('splits on commas and whitespace, dedupes, and lowercases', () => {
    expect(parseHostList('Home.Example.com, vpn.example.com vpn.example.com')).toEqual([
      'home.example.com',
      'vpn.example.com',
    ]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseHostList('')).toEqual([]);
    expect(parseHostList(null)).toEqual([]);
  });
});

describe('resolveHosts', () => {
  it('prefers DDNS_HOSTS over singular values', () => {
    expect(
      resolveHosts({
        hosts: 'a.example.com,b.example.com',
        host: 'ignored.example.com',
      }),
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('falls back to singular host sources', () => {
    expect(resolveHosts({ host: 'home.example.com' })).toEqual(['home.example.com']);
    expect(resolveHosts({ duckdnsDomains: 'one,two' })).toEqual(['one', 'two']);
  });

  it('derives hosts from namecheap host + domain as a last resort', () => {
    expect(resolveHosts({ namecheapHost: 'home', namecheapDomain: 'Example.com' })).toEqual([
      'home.example.com',
    ]);
    expect(resolveHosts({ namecheapHost: '@', namecheapDomain: 'Example.com' })).toEqual([
      'example.com',
    ]);
    expect(resolveHosts({ namecheapDomain: 'example.com' })).toEqual(['example.com']);
    expect(resolveHosts({})).toEqual([]);
  });
});

describe('configForHost', () => {
  it('binds hostname into provider-specific fields', () => {
    const config = makeConfig({
      hosts: ['home.example.com', 'vpn.example.com'],
      cloudflare: { apiToken: 'token', zoneId: 'zone', recordId: 'should-clear' },
      namecheap: { domain: 'example.com', password: 'x' },
    });

    const bound = configForHost(config, 'vpn.example.com');
    expect(bound.hostname).toBe('vpn.example.com');
    expect(bound.cloudflare.recordName).toBe('vpn.example.com');
    expect(bound.cloudflare.recordId).toBeNull();
    expect(bound.duckdns.domains).toBe('vpn.example.com');
    expect(bound.dyndns.hostname).toBe('vpn.example.com');
    expect(bound.namecheap).toEqual({
      host: 'vpn',
      domain: 'example.com',
      password: 'x',
    });
  });
});

describe('bindNamecheapHost', () => {
  it('supports subdomain labels under NAMECHEAP_DOMAIN', () => {
    expect(bindNamecheapHost({ host: '@', domain: 'example.com', password: null }, 'home')).toEqual(
      {
        host: 'home',
        domain: 'example.com',
        password: null,
      },
    );
  });

  it('splits FQDNs when domain is unset', () => {
    expect(
      bindNamecheapHost({ host: '@', domain: null, password: null }, 'home.example.com'),
    ).toEqual({
      host: 'home',
      domain: 'example.com',
      password: null,
    });
  });

  it('maps the apex host to @ and keeps unrelated FQDNs as-is', () => {
    expect(
      bindNamecheapHost({ host: '@', domain: 'Example.com', password: null }, 'EXAMPLE.com'),
    ).toEqual({ host: '@', domain: 'example.com', password: null });

    expect(
      bindNamecheapHost({ host: '@', domain: 'example.com', password: null }, 'other.net'),
    ).toEqual({ host: 'other.net', domain: 'example.com', password: null });
  });

  it('keeps single-label hosts when no domain is configured', () => {
    expect(bindNamecheapHost({ host: '@', domain: null, password: null }, 'home')).toEqual({
      host: 'home',
      domain: null,
      password: null,
    });
    expect(bindNamecheapHost({ host: '@', domain: null, password: null }, '')).toEqual({
      host: '@',
      domain: null,
      password: null,
    });
  });
});
