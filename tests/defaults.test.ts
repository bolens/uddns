import { describe, expect, it } from 'vite-plus/test';

import {
  DEFAULT_CLOUDFLARE_TTL,
  DEFAULT_DYNDNS_UPDATE_URL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  DEFAULT_MCP_TRANSPORT,
  DEFAULT_NAMECHEAP_HOST,
  DEFAULT_PROVIDER,
  DEFAULT_STATE_FILE,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
} from '../lib/defaults.js';
import { PROVIDER_IDS } from '../lib/schemas/provider.js';

describe('runtime defaults', () => {
  it('exports the documented scalar defaults', () => {
    expect(DEFAULT_PROVIDER).toBe('cloudflare');
    expect(PROVIDER_IDS).toContain(DEFAULT_PROVIDER);
    expect(DEFAULT_INTERVAL_MS).toBe(900_000);
    expect(MAX_INTERVAL_MS).toBe(86_400_000);
    expect(MIN_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_STATE_FILE).toBe('.uddns-state.json');
    expect(DEFAULT_DYNDNS_UPDATE_URL).toBe('https://members.dyndns.org/nic/update');
    expect(DEFAULT_CLOUDFLARE_TTL).toBe(1);
    expect(DEFAULT_NAMECHEAP_HOST).toBe('@');
    expect(DEFAULT_MCP_TRANSPORT).toBe('stdio');
    expect(DEFAULT_MCP_HOST).toBe('127.0.0.1');
    expect(DEFAULT_MCP_PORT).toBe(3923);
  });
});
