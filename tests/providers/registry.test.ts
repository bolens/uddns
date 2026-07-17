import { describe, expect, it } from 'vite-plus/test';

import { loadConfig } from '../../lib/config.js';
import { getProvider, listProviderIds, listProviders } from '../../lib/providers/index.js';

describe('provider registry', () => {
  it('exposes a complete Provider contract for every registered provider', () => {
    const providers = listProviders();
    const ids = listProviderIds();

    expect(ids.sort()).toEqual(
      ['cloudflare', 'duckdns', 'dynu', 'dyndns', 'namecheap', 'noip'].sort(),
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
      });
      expect(config.provider).toBe(id);
      expect(getProvider(config.provider).id).toBe(id);
    }
  });

  it('throws a helpful error listing supported providers', () => {
    expect(() => getProvider('spaceship')).toThrow(/Unknown provider[\s\S]*cloudflare/);
  });
});
