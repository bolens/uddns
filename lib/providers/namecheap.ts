import { fail, ok } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { requireFields, requireIPv4 } from './guards.js';
import { getQuery, ipDetails } from './query.js';

export const namecheapProvider: Provider = {
  id: 'namecheap',
  label: 'Namecheap',
  async update(config, ip) {
    const { host, domain, password } = config.namecheap;

    const missing = requireFields(
      'namecheap requires NAMECHEAP_DOMAIN and NAMECHEAP_PASSWORD (Dynamic DNS password)',
      [domain, password],
      {
        hasDomain: Boolean(domain),
        hasPassword: Boolean(password),
        host,
      },
    );
    if (missing) {
      return missing;
    }

    const noIp = requireIPv4(ip, { host, domain });
    if (noIp) {
      return noIp;
    }

    const { response, text, meta } = await getQuery(
      'https://dynamicdns.park-your-domain.com/update',
      {
        host,
        domain: domain!,
        password: password!,
        ip: ip.v4!,
      },
    );

    const errCount = text.match(/<ErrCount>(\d+)<\/ErrCount>/i)?.[1] ?? null;
    const errorText = text.match(/<Err\d+>([^<]+)<\/Err\d+>/i)?.[1] ?? null;
    const details = ipDetails(ip, meta, {
      host,
      domain,
      fqdn: host === '@' ? domain! : `${host}.${domain}`,
      errCount,
      errorText,
    });

    if (response.ok && errCount === '0') {
      return ok(`Updated ${host === '@' ? domain : `${host}.${domain}`} -> ${ip.v4}`, details);
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
