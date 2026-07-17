import { fail } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { sanitizeUrl } from './http.js';
import { updateNicDns } from './nic-update.js';

export const dyndnsProvider: Provider = {
  id: 'dyndns',
  label: 'DynDNS-compatible',
  async update(config, ip) {
    const { updateUrl, username, password, hostname } = config.dyndns;

    if (!username || !password || !hostname) {
      return fail(
        'dyndns requires UDDNS_USER, UDDNS_PASS, and UDDNS_HOST / UDDNS_HOSTS (or DYNDNS_* equivalents)',
        {
          updateUrl: sanitizeUrl(updateUrl),
          hasUser: Boolean(username),
          hasPassword: Boolean(password),
          hostname,
        },
      );
    }

    return updateNicDns({
      updateUrl,
      username,
      password,
      hostname,
      ip,
    });
  },
};
