import type { Provider } from '../schemas/provider.js';
import { requireFields } from './guards.js';
import { sanitizeUrl } from './http.js';
import { updateNicDns } from './nic-update.js';

export const dyndnsProvider: Provider = {
  id: 'dyndns',
  label: 'DynDNS-compatible',
  async update(config, ip) {
    const { updateUrl, username, password, hostname } = config.dyndns;

    const missing = requireFields(
      'dyndns requires UDDNS_USER, UDDNS_PASS, and UDDNS_HOST / UDDNS_HOSTS (or DYNDNS_* equivalents)',
      [username, password, hostname],
      {
        updateUrl: sanitizeUrl(updateUrl),
        hasUser: Boolean(username),
        hasPassword: Boolean(password),
        hostname,
      },
    );
    if (missing) {
      return missing;
    }

    return updateNicDns({
      updateUrl,
      username: username!,
      password: password!,
      hostname: hostname!,
      ip,
    });
  },
};
