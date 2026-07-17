/**
 * Scalar runtime defaults shared by config loading, fixtures, and docs contracts.
 */

import type { ProviderId } from './schemas/provider.js';

export const DEFAULT_PROVIDER: ProviderId = 'cloudflare';
export const DEFAULT_INTERVAL_MS = 900_000;
export const DEFAULT_STATE_FILE = '.uddns-state.json';
export const DEFAULT_DYNDNS_UPDATE_URL = 'https://members.dyndns.org/nic/update';
export const DEFAULT_CLOUDFLARE_TTL = 1;
export const DEFAULT_NAMECHEAP_HOST = '@';
