import { fail } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { updateNicDns } from './nic-update.js';

export const dyndnsProvider: Provider = {
  id: 'dyndns',
  label: 'DynDNS-compatible',
  async update(config, ip) {
    const { updateUrl, username, password, hostname } = config.dyndns;

    if (!username || !password || !hostname) {
      return fail(
        'dyndns requires DDNS_USER, DDNS_PASS, and DDNS_HOST / DDNS_HOSTS (or DYNDNS_* equivalents)',
        {
          updateUrl,
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
