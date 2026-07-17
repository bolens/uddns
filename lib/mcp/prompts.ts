/**
 * MCP prompt templates for setup and diagnosis.
 */

import { PROVIDER_IDS, type ProviderId } from '../schemas/provider.js';
import type { McpSession } from './session.js';
import { createToolHandlers } from './tools.js';

const PROVIDER_HINTS: Record<ProviderId, string[]> = {
  cloudflare: [
    'CLOUDFLARE_API_TOKEN (Zone → DNS → Edit)',
    'CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME',
    'UDDNS_HOSTS (FQDNs to update)',
  ],
  duckdns: ['DUCKDNS_TOKEN', 'UDDNS_HOSTS or DUCKDNS_DOMAINS (DuckDNS subdomains)'],
  noip: ['UDDNS_USER', 'UDDNS_PASS', 'UDDNS_HOSTS'],
  dynu: ['UDDNS_USER', 'UDDNS_PASS', 'UDDNS_HOSTS'],
  namecheap: [
    'NAMECHEAP_PASSWORD (Dynamic DNS password)',
    'NAMECHEAP_DOMAIN (unless hosts are FQDNs)',
    'UDDNS_HOSTS',
  ],
  dyndns: [
    'UDDNS_USER',
    'UDDNS_PASS',
    'UDDNS_HOSTS',
    'Optional DYNDNS_UPDATE_URL (must be https://)',
  ],
  route53: [
    'ROUTE53_ACCESS_KEY_ID',
    'ROUTE53_SECRET_ACCESS_KEY',
    'ROUTE53_HOSTED_ZONE_ID',
    'UDDNS_HOSTS (FQDNs to update)',
  ],
  porkbun: [
    'PORKBUN_API_KEY',
    'PORKBUN_SECRET_KEY',
    'PORKBUN_DOMAIN (unless hosts are FQDNs)',
    'UDDNS_HOSTS',
  ],
  hetzner: ['HETZNER_API_TOKEN', 'HETZNER_ZONE_ID or HETZNER_ZONE_NAME', 'UDDNS_HOSTS'],
  digitalocean: [
    'DIGITALOCEAN_API_TOKEN',
    'DIGITALOCEAN_DOMAIN (unless hosts are FQDNs)',
    'UDDNS_HOSTS',
  ],
  gandi: ['GANDI_API_TOKEN', 'GANDI_DOMAIN', 'UDDNS_HOSTS'],
  linode: ['LINODE_API_TOKEN', 'LINODE_DOMAIN_ID', 'LINODE_DOMAIN', 'UDDNS_HOSTS'],
  ovh: [
    'OVH_APPLICATION_KEY',
    'OVH_APPLICATION_SECRET',
    'OVH_CONSUMER_KEY',
    'OVH_ZONE',
    'UDDNS_HOSTS',
  ],
  bunny: ['BUNNY_API_KEY', 'BUNNY_ZONE_ID', 'BUNNY_DOMAIN', 'UDDNS_HOSTS'],
  contabo: [
    'CONTABO_CLIENT_ID',
    'CONTABO_CLIENT_SECRET',
    'CONTABO_API_USER',
    'CONTABO_API_PASSWORD',
    'CONTABO_ZONE',
    'UDDNS_HOSTS',
  ],
};

export function buildSetupProviderPrompt(providerId: string): {
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} {
  const normalized = providerId.toLowerCase();
  if (!PROVIDER_IDS.includes(normalized as ProviderId)) {
    throw new Error(`Unknown provider "${providerId}". Supported: ${PROVIDER_IDS.join(', ')}`);
  }
  const id = normalized as ProviderId;
  const lines = [
    `Set up uDDNS for provider \`${id}\`.`,
    '',
    'Required / typical environment variables:',
    ...PROVIDER_HINTS[id].map((hint) => `- ${hint}`),
    '',
    'Also set:',
    '- `UDDNS_PROVIDER=' + id + '`',
    '- `UDDNS_INTERVAL` (milliseconds, default 900000)',
    '',
    'Validate with `vp run config:check` after building, then start the MCP daemon or stdio server.',
  ];

  return {
    description: `Guided environment checklist for the ${id} provider`,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: lines.join('\n') },
      },
    ],
  };
}

export async function buildDiagnoseUpdatePrompt(
  session: McpSession,
  options: {
    discoverPublicIPFn?: () => Promise<import('../ip.js').PublicIPDiscovery>;
  } = {},
): Promise<{
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
}> {
  const handlers = createToolHandlers(session, options);
  const status = handlers.getStatus();
  const config = handlers.getConfig();
  const history = await handlers.getHistory();
  let publicIp: unknown;
  try {
    publicIp = await handlers.getPublicIp();
  } catch (error) {
    publicIp = {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const text = [
    'Diagnose a uDDNS update failure or skipped cycle.',
    '',
    'Current status (JSON):',
    '```json',
    JSON.stringify(status, null, 2),
    '```',
    '',
    'Redacted config (JSON):',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
    '',
    'Public IP discovery (JSON):',
    '```json',
    JSON.stringify(publicIp, null, 2),
    '```',
    '',
    'Recent history (JSON):',
    '```json',
    JSON.stringify(history, null, 2),
    '```',
    '',
    'Use this decision order:',
    '1. No IP: inspect outbound HTTPS/DNS and discovery configuration.',
    '2. Authentication/authorization: verify provider credentials and zone access.',
    '3. HTTP 429/5xx: respect retry timing and check provider health.',
    '4. Partial host failures: isolate failed hosts and dry-run only those hosts.',
    '5. Unchanged: confirm checkpoints and force only when DNS is actually stale.',
    '',
    'Return concrete next steps without exposing secrets.',
  ].join('\n');

  return {
    description: 'Walk through status, redacted config, and public IP to diagnose update issues',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

export function buildFixConfigPrompt(session: McpSession): {
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} {
  const handlers = createToolHandlers(session);
  const validation = handlers.validateConfig();
  const config = handlers.getConfig();
  const text = [
    'Propose the smallest safe uDDNS configuration patch.',
    '',
    'Validation result:',
    '```json',
    JSON.stringify(validation, null, 2),
    '```',
    '',
    'Current redacted configuration:',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
    '',
    'Return both:',
    '1. An `.env` patch using placeholders for secrets.',
    '2. A multi-account YAML patch when applicable.',
    '',
    'Never invent or print credential values. Recommend validate_config and dry_run before updates.',
  ].join('\n');
  return {
    description: 'Generate a safe redacted configuration patch from validation issues',
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}
