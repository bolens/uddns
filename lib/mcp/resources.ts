/**
 * MCP resource helpers for uddns:// URIs.
 */

import type { McpSession } from './session.js';
import { createToolHandlers, jsonText } from './tools.js';

export const MCP_RESOURCE_URIS = {
  config: 'uddns://config',
  publicIp: 'uddns://public-ip',
  status: 'uddns://status',
  history: 'uddns://history',
} as const;

export async function readMcpResource(
  session: McpSession,
  uri: string,
  options: {
    discoverPublicIPFn?: () => Promise<import('../ip.js').PublicIPDiscovery>;
  } = {},
): Promise<{ mimeType: string; text: string }> {
  const handlers = createToolHandlers(session, options);

  switch (uri) {
    case MCP_RESOURCE_URIS.config:
      return {
        mimeType: 'application/json',
        text: jsonText(
          session.accounts && session.accounts.length > 1
            ? {
                accounts: session.accounts.map((account) => handlers.getConfig(account.id)),
              }
            : handlers.getConfig(),
        ),
      };
    case MCP_RESOURCE_URIS.publicIp:
      return { mimeType: 'application/json', text: jsonText(await handlers.getPublicIp()) };
    case MCP_RESOURCE_URIS.status:
      return {
        mimeType: 'application/json',
        text: jsonText(
          session.accounts && session.accounts.length > 1
            ? handlers.getAccountsStatus()
            : handlers.getStatus(),
        ),
      };
    case MCP_RESOURCE_URIS.history:
      return {
        mimeType: 'application/json',
        text: jsonText(
          session.accounts && session.accounts.length > 1
            ? {
                accounts: await Promise.all(
                  session.accounts.map((account) => handlers.getHistory(account.id)),
                ),
              }
            : await handlers.getHistory(),
        ),
      };
    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }
}
