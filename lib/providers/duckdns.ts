import { stripDuckDnsSuffix } from '../hosts.js';
import { fail, ok } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { requireFields, requireIPv4 } from './guards.js';
import { getQuery, ipDetails } from './query.js';

export const duckdnsProvider: Provider = {
  id: 'duckdns',
  label: 'DuckDNS',
  async update(config, ip) {
    const domains = config.duckdns.domains;
    const token = config.duckdns.token;

    const missing = requireFields(
      'duckdns requires DUCKDNS_DOMAINS (or UDDNS_HOST / UDDNS_HOSTS) and DUCKDNS_TOKEN',
      [domains, token],
      {
        hasDomains: Boolean(domains),
        hasToken: Boolean(token),
      },
    );
    if (missing) {
      return missing;
    }

    const noIp = requireIPv4(ip, { domains });
    if (noIp) {
      return noIp;
    }

    const { response, text, meta } = await getQuery('https://www.duckdns.org/update', {
      domains: stripDuckDnsSuffix(domains!),
      token: token!,
      ip: ip.v4!,
      ...(ip.v6 ? { ipv6: ip.v6 } : {}),
      verbose: 'true',
    });

    const details = ipDetails(ip, meta, { domains });

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
