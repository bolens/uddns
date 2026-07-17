import { fail, ok } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { request } from './http.js';

export const duckdnsProvider: Provider = {
  id: 'duckdns',
  label: 'DuckDNS',
  async update(config, ip) {
    const domains = config.duckdns.domains;
    const token = config.duckdns.token;

    if (!domains || !token) {
      return fail(
        'duckdns requires DUCKDNS_DOMAINS (or DDNS_HOST / DDNS_HOSTS) and DUCKDNS_TOKEN',
        {
          hasDomains: Boolean(domains),
          hasToken: Boolean(token),
        },
      );
    }

    if (!ip.v4) {
      return fail('No public IPv4 available', { domains, ip });
    }

    const url = new URL('https://www.duckdns.org/update');
    url.searchParams.set('domains', domains.replace(/\.duckdns\.org$/i, ''));
    url.searchParams.set('token', token);
    url.searchParams.set('ip', ip.v4);
    if (ip.v6) {
      url.searchParams.set('ipv6', ip.v6);
    }
    url.searchParams.set('verbose', 'true');

    const { response, body, meta } = await request(url, { method: 'GET' });
    const text = body.trim();
    const details = {
      domains,
      ipv4: ip.v4,
      ipv6: ip.v6,
      ...meta,
    };

    if (response.ok && /^OK/i.test(text)) {
      return ok(text, details);
    }

    return fail(
      text
        ? `DuckDNS update failed: ${text}`
        : `DuckDNS update failed with HTTP ${response.status} ${response.statusText}`,
      {
        ...details,
        hint: 'Check DUCKDNS_TOKEN and that the domain exists on your DuckDNS account',
      },
    );
  },
};
