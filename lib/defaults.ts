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
export const DEFAULT_ROUTE53_REGION = 'us-east-1';
export const DEFAULT_ROUTE53_TTL = 300;
export const DEFAULT_DNS_TTL = 300;
export const DEFAULT_MCP_TRANSPORT = 'stdio' as const;
export const DEFAULT_MCP_HOST = '127.0.0.1';
export const DEFAULT_MCP_PORT = 3923;
export const DEFAULT_HISTORY_FILE = '.uddns-history.json';
export const DEFAULT_HISTORY_MAX = 50;
export const DEFAULT_IP_FAMILY = 'dual' as const;
export const DEFAULT_IP_MISSING = 'keep' as const;
export const DEFAULT_IP_TIMEOUT_MS = 5_000;
export const DEFAULT_IP_DNS_FALLBACK = false;
export const DEFAULT_HEALTH_HOST = '127.0.0.1';
export const DEFAULT_HEALTH_PORT = 3924;
export const DEFAULT_NOTIFY_ON = ['change', 'error'] as const;
export const DEFAULT_LOG_FORMAT = 'text' as const;
