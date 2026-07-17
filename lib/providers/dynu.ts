import { fail } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { updateNicDns } from './nic-update.js';

export const dynuProvider: Provider = {
  id: 'dynu',
  label: 'Dynu',
  async update(config, ip) {
    const username = config.user;
    const password = config.password ?? config.token;
    const hostname = config.hostname;

    if (!username || !password || !hostname) {
      return fail(
        'dynu requires UDDNS_USER, UDDNS_PASS (or UDDNS_TOKEN), and UDDNS_HOST / UDDNS_HOSTS',
        {
          hasUser: Boolean(username),
          hasPassword: Boolean(password),
          hostname,
        },
      );
    }

    return updateNicDns({
      updateUrl: 'https://api.dynu.com/nic/update',
      username,
      password,
      hostname,
      ip,
      ipv6Param: 'myipv6',
    });
  },
};
