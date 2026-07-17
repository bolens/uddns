/**
 * Provider registry.
 */

import type { Provider, ProviderId } from '../schemas/provider.js';
import { PROVIDER_IDS, providerIdSchema } from '../schemas/provider.js';
import { cloudflareProvider } from './cloudflare.js';
import { duckdnsProvider } from './duckdns.js';
import { dyndnsProvider } from './dyndns.js';
import { dynuProvider } from './dynu.js';
import { namecheapProvider } from './namecheap.js';
import { noipProvider } from './noip.js';

const providers = {
  cloudflare: cloudflareProvider,
  duckdns: duckdnsProvider,
  noip: noipProvider,
  dynu: dynuProvider,
  namecheap: namecheapProvider,
  dyndns: dyndnsProvider,
} satisfies Record<ProviderId, Provider>;

export function getProvider(id: string): Provider {
  const parsed = providerIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(`Unknown provider: ${id}. Supported: ${listProviderIds().join(', ')}`);
  }
  return providers[parsed.data];
}

export function listProviders(): Provider[] {
  return Object.values(providers);
}

export function listProviderIds(): ProviderId[] {
  return [...PROVIDER_IDS];
}
