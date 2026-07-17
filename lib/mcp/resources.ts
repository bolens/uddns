/**
 * MCP resource helpers for uddns:// URIs.
 */

import type { McpSession } from './session.js';
import { createToolHandlers, jsonText } from './tools.js';

export const MCP_RESOURCE_URIS = {
  config: 'uddns://config',
  publicIp: 'uddns://public-ip',
  status: 'uddns://status',
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
      return { mimeType: 'application/json', text: jsonText(handlers.getConfig()) };
    case MCP_RESOURCE_URIS.publicIp:
      return { mimeType: 'application/json', text: jsonText(await handlers.getPublicIp()) };
    case MCP_RESOURCE_URIS.status:
      return { mimeType: 'application/json', text: jsonText(handlers.getStatus()) };
    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }
}
