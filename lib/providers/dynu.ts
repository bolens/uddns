import type { Provider } from '../schemas/provider.js';
import { requireFields } from './guards.js';
import { updateNicDns } from './nic-update.js';

export const dynuProvider: Provider = {
  id: 'dynu',
  label: 'Dynu',
  async update(config, ip) {
    const username = config.user;
    const password = config.password ?? config.token;
    const hostname = config.hostname;

    const missing = requireFields(
      'dynu requires UDDNS_USER, UDDNS_PASS (or UDDNS_TOKEN), and UDDNS_HOST / UDDNS_HOSTS',
      [username, password, hostname],
      {
        hasUser: Boolean(username),
        hasPassword: Boolean(password),
        hostname,
      },
    );
    if (missing) {
      return missing;
    }

    return updateNicDns({
      updateUrl: 'https://api.dynu.com/nic/update',
      username: username!,
      password: password!,
      hostname: hostname!,
      ip,
      ipv6Param: 'myipv6',
    });
  },
};
