/**
 * Build an MCP server wired to a shared uDDNS session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import { providerIdSchema } from '../schemas/provider.js';
import { buildDiagnoseUpdatePrompt, buildSetupProviderPrompt } from './prompts.js';
import { MCP_RESOURCE_URIS, readMcpResource } from './resources.js';
import type { McpSession } from './session.js';
import { createToolHandlers, jsonText } from './tools.js';

export const MCP_TOOL_NAMES = [
  'list_providers',
  'get_public_ip',
  'get_config',
  'check_once',
  'get_status',
  'set_interval',
  'start_loop',
  'stop_loop',
] as const;

export const MCP_PROMPT_NAMES = ['setup_provider', 'diagnose_update'] as const;

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: jsonText(value) }],
  };
}

export function createUddnsMcpServer(session: McpSession): McpServer {
  const handlers = createToolHandlers(session);
  const server = new McpServer({
    name: 'uddns',
    version: packageJson.version,
  });

  server.registerTool(
    MCP_TOOL_NAMES[0],
    {
      description: 'List Dynamic DNS providers supported by uDDNS',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(handlers.listProviders()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[1],
    {
      description: 'Discover the current public IPv4/IPv6 addresses',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => textResult(await handlers.getPublicIp()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[2],
    {
      description: 'Return the loaded uDDNS configuration with secrets redacted',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(handlers.getConfig()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[3],
    {
      description: 'Run one guarded IP check / DNS update cycle on the shared updater session',
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async () => textResult(await handlers.checkOnce()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[4],
    {
      description: 'Return updater session status (running, interval, IP, cycle)',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(handlers.getStatus()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[5],
    {
      description: 'Set the updater check interval in milliseconds (>= 1000)',
      inputSchema: {
        intervalMs: z.number().int().min(1000).describe('Check interval in milliseconds'),
      },
    },
    async ({ intervalMs }) => textResult(handlers.setInterval(intervalMs)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[6],
    {
      description:
        'Start the updater interval loop (runs one immediate check, then schedules ticks)',
    },
    async () => textResult(await handlers.startLoop()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[7],
    {
      description: 'Stop the updater interval loop and wait for any in-flight cycle',
    },
    async () => textResult(await handlers.stopLoop()),
  );

  server.registerResource(
    'config',
    MCP_RESOURCE_URIS.config,
    {
      description: 'Redacted uDDNS configuration',
      mimeType: 'application/json',
    },
    async (uri) => {
      const body = await readMcpResource(session, uri.href);
      return { contents: [{ uri: uri.href, mimeType: body.mimeType, text: body.text }] };
    },
  );

  server.registerResource(
    'public-ip',
    MCP_RESOURCE_URIS.publicIp,
    {
      description: 'Current public IP discovery result',
      mimeType: 'application/json',
    },
    async (uri) => {
      const body = await readMcpResource(session, uri.href);
      return { contents: [{ uri: uri.href, mimeType: body.mimeType, text: body.text }] };
    },
  );

  server.registerResource(
    'status',
    MCP_RESOURCE_URIS.status,
    {
      description: 'Updater session status',
      mimeType: 'application/json',
    },
    async (uri) => {
      const body = await readMcpResource(session, uri.href);
      return { contents: [{ uri: uri.href, mimeType: body.mimeType, text: body.text }] };
    },
  );

  server.registerPrompt(
    MCP_PROMPT_NAMES[0],
    {
      description: 'Guided environment checklist for a DDNS provider',
      argsSchema: {
        provider: providerIdSchema.describe('Provider id to configure'),
      },
    },
    async ({ provider }) => buildSetupProviderPrompt(provider),
  );

  server.registerPrompt(
    MCP_PROMPT_NAMES[1],
    {
      description: 'Diagnose a failed or skipped DNS update using live session data',
    },
    async () => buildDiagnoseUpdatePrompt(session),
  );

  return server;
}
