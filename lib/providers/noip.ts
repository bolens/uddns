import type { Provider } from '../schemas/provider.js';
import { requireFields } from './guards.js';
import { updateNicDns } from './nic-update.js';

export const noipProvider: Provider = {
  id: 'noip',
  label: 'No-IP',
  async update(config, ip) {
    const username = config.user;
    const password = config.password;
    const hostname = config.hostname;

    const missing = requireFields(
      'noip requires UDDNS_USER, UDDNS_PASS, and UDDNS_HOST / UDDNS_HOSTS',
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
      updateUrl: 'https://dynupdate.no-ip.com/nic/update',
      username: username!,
      password: password!,
      hostname: hostname!,
      ip,
    });
  },
};
