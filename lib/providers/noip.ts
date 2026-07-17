import { fail } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { updateNicDns } from './nic-update.js';

export const noipProvider: Provider = {
  id: 'noip',
  label: 'No-IP',
  async update(config, ip) {
    const username = config.user;
    const password = config.password;
    const hostname = config.hostname;

    if (!username || !password || !hostname) {
      return fail('noip requires DDNS_USER, DDNS_PASS, and DDNS_HOST / DDNS_HOSTS', {
        hasUser: Boolean(username),
        hasPassword: Boolean(password),
        hostname,
      });
    }

    return updateNicDns({
      updateUrl: 'https://dynupdate.no-ip.com/nic/update',
      username,
      password,
      hostname,
      ip,
    });
  },
};
