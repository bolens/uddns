import { describe, expect, it } from 'vite-plus/test';

import { loadConfig } from '../../lib/config.js';
import { getProvider, listProviderIds, listProviders } from '../../lib/providers/index.js';

describe('provider registry', () => {
  it('exposes a complete Provider contract for every registered provider', () => {
    const providers = listProviders();
    const ids = listProviderIds();

    expect(ids.sort()).toEqual(
      [
        'bunny',
        'cloudflare',
        'contabo',
        'digitalocean',
        'duckdns',
        'dyndns',
        'dynu',
        'gandi',
        'hetzner',
        'linode',
        'namecheap',
        'noip',
        'ovh',
        'porkbun',
        'route53',
      ].sort(),
    );
    expect(providers).toHaveLength(ids.length);

    for (const provider of providers) {
      expect(provider.id).toEqual(expect.any(String));
      expect(provider.id.length).toBeGreaterThan(0);
      expect(provider.label).toEqual(expect.any(String));
      expect(provider.label.length).toBeGreaterThan(0);
      expect(typeof provider.update).toBe('function');
      expect(getProvider(provider.id)).toBe(provider);
    }
  });

  it('accepts every registered provider id in loadConfig', () => {
    for (const id of listProviderIds()) {
      const config = loadConfig({
        UDDNS_PROVIDER: id,
        UDDNS_HOST: 'home.example.com',
        UDDNS_USER: 'user',
        UDDNS_PASS: 'pass',
        CLOUDFLARE_API_TOKEN: 'token',
        DUCKDNS_TOKEN: 'token',
        NAMECHEAP_DOMAIN: 'example.com',
        NAMECHEAP_PASSWORD: 'ddns',
        ROUTE53_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        ROUTE53_SECRET_ACCESS_KEY: 'secret',
        ROUTE53_HOSTED_ZONE_ID: 'Z123',
        PORKBUN_API_KEY: 'pk',
        PORKBUN_SECRET_KEY: 'sk',
        HETZNER_API_TOKEN: 'token',
        DIGITALOCEAN_API_TOKEN: 'token',
        GANDI_API_TOKEN: 'token',
        GANDI_DOMAIN: 'example.com',
        LINODE_API_TOKEN: 'token',
        LINODE_DOMAIN_ID: '42',
        LINODE_DOMAIN: 'example.com',
        OVH_APPLICATION_KEY: 'ak',
        OVH_APPLICATION_SECRET: 'as',
        OVH_CONSUMER_KEY: 'ck',
        OVH_ZONE: 'example.com',
        BUNNY_API_KEY: 'key',
        BUNNY_ZONE_ID: '7',
        BUNNY_DOMAIN: 'example.com',
        CONTABO_CLIENT_ID: 'cid',
        CONTABO_CLIENT_SECRET: 'csecret',
        CONTABO_API_USER: 'user',
        CONTABO_API_PASSWORD: 'pass',
        CONTABO_ZONE: 'example.com',
      });
      expect(config.provider).toBe(id);
      expect(getProvider(config.provider).id).toBe(id);
    }
  });

  it('throws a helpful error listing supported providers', () => {
    expect(() => getProvider('spaceship')).toThrow(/Unknown provider[\s\S]*cloudflare/);
  });
});
