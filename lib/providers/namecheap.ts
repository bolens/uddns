import { fail, ok } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { request } from './http.js';

export const namecheapProvider: Provider = {
  id: 'namecheap',
  label: 'Namecheap',
  async update(config, ip) {
    const { host, domain, password } = config.namecheap;

    if (!domain || !password) {
      return fail(
        'namecheap requires NAMECHEAP_DOMAIN and NAMECHEAP_PASSWORD (Dynamic DNS password)',
        {
          hasDomain: Boolean(domain),
          hasPassword: Boolean(password),
          host,
        },
      );
    }

    if (!ip.v4) {
      return fail('No public IPv4 available', { host, domain, ip });
    }

    const url = new URL('https://dynamicdns.park-your-domain.com/update');
    url.searchParams.set('host', host);
    url.searchParams.set('domain', domain);
    url.searchParams.set('password', password);
    url.searchParams.set('ip', ip.v4);

    const { response, body, meta } = await request(url, { method: 'GET' });
    const text = body.trim();
    const errCount = text.match(/<ErrCount>(\d+)<\/ErrCount>/i)?.[1] ?? null;
    const errorText = text.match(/<Err\d+>([^<]+)<\/Err\d+>/i)?.[1] ?? null;
    const details = {
      host,
      domain,
      fqdn: `${host}.${domain}`,
      ipv4: ip.v4,
      errCount,
      errorText,
      ...meta,
    };

    if (response.ok && errCount === '0') {
      return ok(`Updated ${host}.${domain} -> ${ip.v4}`, details);
    }

    return fail(
      errorText
        ? `Namecheap update failed: ${errorText}`
        : `Namecheap update failed (ErrCount=${errCount ?? '?'}, HTTP ${response.status})`,
      {
        ...details,
        hint: 'Use the Dynamic DNS password from Namecheap (not your account password)',
      },
    );
  },
};
