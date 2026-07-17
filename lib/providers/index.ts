/**
 * Provider registry.
 */

import type { Provider, ProviderId } from '../schemas/provider.js';
import { PROVIDER_IDS, providerIdSchema } from '../schemas/provider.js';
import { cloudflareProvider } from './cloudflare.js';
import { bunnyProvider } from './bunny.js';
import { contaboProvider } from './contabo.js';
import { digitaloceanProvider } from './digitalocean.js';
import { gandiProvider } from './gandi.js';
import { duckdnsProvider } from './duckdns.js';
import { dyndnsProvider } from './dyndns.js';
import { dynuProvider } from './dynu.js';
import { hetznerProvider } from './hetzner.js';
import { linodeProvider } from './linode.js';
import { namecheapProvider } from './namecheap.js';
import { noipProvider } from './noip.js';
import { ovhProvider } from './ovh.js';
import { porkbunProvider } from './porkbun.js';
import { route53Provider } from './route53.js';

const providers = {
  cloudflare: cloudflareProvider,
  duckdns: duckdnsProvider,
  noip: noipProvider,
  dynu: dynuProvider,
  namecheap: namecheapProvider,
  dyndns: dyndnsProvider,
  route53: route53Provider,
  porkbun: porkbunProvider,
  hetzner: hetznerProvider,
  digitalocean: digitaloceanProvider,
  gandi: gandiProvider,
  linode: linodeProvider,
  ovh: ovhProvider,
  bunny: bunnyProvider,
  contabo: contaboProvider,
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
