/**
 * Build an MCP server wired to a shared uDDNS session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import { buildEnvContents } from '../init.js';
import { PROVIDER_IDS_LIST } from '../init-defaults.js';
import { providerIdSchema } from '../schemas/provider.js';
import {
  buildDiagnoseUpdatePrompt,
  buildFixConfigPrompt,
  buildSetupProviderPrompt,
} from './prompts.js';
import { MCP_RESOURCE_URIS, readMcpResource } from './resources.js';
import type { McpAccount, McpSession } from './session.js';
import { createToolHandlers, jsonText } from './tools.js';

export type UddnsMcpServer = McpServer & { dispose: () => void };

export const MCP_TOOL_NAMES = [
  'list_providers',
  'list_accounts',
  'get_public_ip',
  'get_config',
  'check_once',
  'force_update',
  'dry_run',
  'update_hosts',
  'get_status',
  'get_history',
  'validate_config',
  'explain_last_cycle',
  'set_interval',
  'start_loop',
  'stop_loop',
  'init_config',
] as const;

export const MCP_PROMPT_NAMES = ['setup_provider', 'diagnose_update', 'fix_config'] as const;

const outputSchema = { result: z.unknown() };
const accountIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Account id from list_accounts; defaults to the primary account');

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: jsonText(value) }],
    structuredContent: { result: value },
  };
}

function normalizeSession(session: McpSession): McpSession & {
  accountId: string;
  accounts: McpAccount[];
} {
  if (session.accounts?.length) {
    return {
      ...session,
      accountId: session.accountId ?? session.accounts[0]!.id,
      accounts: session.accounts,
    };
  }
  const account: McpAccount = {
    id: session.accountId ?? 'default',
    config: session.config,
    provider: session.provider,
    updater: session.updater,
    history: session.history,
    metrics: session.metrics,
    eventListeners: session.eventListeners,
  };
  return {
    ...session,
    accountId: account.id,
    accounts: [account],
  };
}

type ProgressExtra = {
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification?:
    | ((notification: {
        method: 'notifications/progress';
        params: {
          progressToken: string | number;
          progress: number;
          total?: number;
          message?: string;
        };
      }) => Promise<void>)
    | undefined;
};

async function reportProgress(
  extra: ProgressExtra | undefined,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) {
    return;
  }
  await extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken: token, progress, total, message },
  });
}

export function createUddnsMcpServer(sessionInput: McpSession): UddnsMcpServer {
  const session = normalizeSession(sessionInput);
  const handlers = createToolHandlers(session);
  const server = new McpServer({
    name: 'uddns',
    version: packageJson.version,
  });
  server.server.registerCapabilities({
    resources: { subscribe: true },
  });
  const subscriptions = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  const notifyResources = (): void => {
    const updates = [MCP_RESOURCE_URIS.status, MCP_RESOURCE_URIS.history]
      .filter((uri) => subscriptions.size === 0 || subscriptions.has(uri))
      .map((uri) => server.server.sendResourceUpdated({ uri }));
    void Promise.all(updates).catch(() => {
      // Client may disconnect between the cycle event and notification.
    });
  };
  for (const account of session.accounts) {
    account.eventListeners?.add(notifyResources);
  }
  const dispose = (): void => {
    for (const account of session.accounts) {
      account.eventListeners?.delete(notifyResources);
    }
    subscriptions.clear();
  };

  server.registerTool(
    MCP_TOOL_NAMES[0],
    {
      description: 'List Dynamic DNS providers supported by uDDNS',
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async () => toolResult(handlers.listProviders()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[1],
    {
      description: 'List configured MCP accounts (multi-account YAML or single default)',
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async () => toolResult(handlers.listAccounts()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[2],
    {
      description: 'Discover the current public IPv4/IPv6 addresses',
      annotations: { readOnlyHint: true, openWorldHint: true },
      outputSchema,
    },
    async () => toolResult(await handlers.getPublicIp()),
  );

  server.registerTool(
    MCP_TOOL_NAMES[3],
    {
      description: 'Return the loaded uDDNS configuration with secrets redacted',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(handlers.getConfig(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[4],
    {
      description: 'Run one guarded IP check / DNS update cycle on the shared updater session',
      inputSchema: { accountId: accountIdSchema },
      annotations: { destructiveHint: true, openWorldHint: true },
      outputSchema,
    },
    async ({ accountId }, extra) => {
      await reportProgress(extra, 1, 3, 'Starting update cycle');
      const result = await handlers.checkOnce(accountId);
      await reportProgress(extra, 3, 3, 'Cycle complete');
      return toolResult(result);
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES[5],
    {
      description: 'Force a DNS update for all hosts regardless of checkpoint state',
      inputSchema: { accountId: accountIdSchema },
      annotations: { destructiveHint: true, openWorldHint: true },
      outputSchema,
    },
    async ({ accountId }, extra) => {
      await reportProgress(extra, 1, 2, 'Forcing updates');
      const result = await handlers.forceUpdate(accountId);
      await reportProgress(extra, 2, 2, 'Force update complete');
      return toolResult(result);
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES[6],
    {
      description: 'Dry-run one cycle: show which hosts would update without calling the provider',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(await handlers.dryRun(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[7],
    {
      description: 'Update only selected configured hosts, optionally as a force or dry run',
      inputSchema: {
        hosts: z.array(z.string().min(1)).min(1).describe('Configured hosts to target'),
        force: z.boolean().optional().describe('Ignore host checkpoints'),
        dryRun: z.boolean().optional().describe('Preview without provider calls'),
        accountId: accountIdSchema,
      },
      annotations: { destructiveHint: true, openWorldHint: true },
      outputSchema,
    },
    async ({ hosts, force, dryRun, accountId }, extra) => {
      await reportProgress(extra, 1, 2, `Updating ${hosts.length} host(s)`);
      const result = await handlers.updateHosts(hosts, {
        ...(force !== undefined ? { force } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
      });
      await reportProgress(extra, 2, 2, 'Host update complete');
      return toolResult(result);
    },
  );

  server.registerTool(
    MCP_TOOL_NAMES[8],
    {
      description: 'Return updater session status (running, interval, IP, cycle)',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async ({ accountId }) =>
      toolResult(
        accountId || (session.accounts?.length ?? 0) <= 1
          ? handlers.getStatus(accountId)
          : handlers.getAccountsStatus(),
      ),
  );

  server.registerTool(
    MCP_TOOL_NAMES[9],
    {
      description: 'Return recent updater cycle history',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(await handlers.getHistory(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[10],
    {
      description: 'Validate the active provider configuration with field-level guidance',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(handlers.validateConfig(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[11],
    {
      description: 'Explain the last updater cycle and return concrete next steps',
      inputSchema: { accountId: accountIdSchema },
      annotations: { readOnlyHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(await handlers.explainLastCycle(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[12],
    {
      description: 'Set the updater check interval in milliseconds (>= 1000)',
      inputSchema: {
        intervalMs: z.number().int().min(1000).describe('Check interval in milliseconds'),
        accountId: accountIdSchema,
      },
      annotations: { idempotentHint: true },
      outputSchema,
    },
    async ({ intervalMs, accountId }) => toolResult(handlers.setInterval(intervalMs, accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[13],
    {
      description:
        'Start the updater interval loop (runs one immediate check, then schedules ticks)',
      inputSchema: { accountId: accountIdSchema },
      annotations: { idempotentHint: true, openWorldHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(await handlers.startLoop(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[14],
    {
      description: 'Stop the updater interval loop and wait for any in-flight cycle',
      inputSchema: { accountId: accountIdSchema },
      annotations: { idempotentHint: true },
      outputSchema,
    },
    async ({ accountId }) => toolResult(await handlers.stopLoop(accountId)),
  );

  server.registerTool(
    MCP_TOOL_NAMES[15],
    {
      description:
        'Elicit non-secret init values and return a redacted .env template (credentials left blank)',
      annotations: { idempotentHint: true },
      outputSchema,
    },
    async () => {
      try {
        const elicited = await server.server.elicitInput({
          message: 'Choose non-secret uDDNS init values. Do not enter credentials here.',
          requestedSchema: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                description: `Provider id (${PROVIDER_IDS_LIST.join(', ')})`,
              },
              hosts: {
                type: 'string',
                description: 'Comma-separated hostnames',
              },
              intervalMs: {
                type: 'string',
                description: 'Check interval in milliseconds',
              },
            },
            required: ['provider', 'hosts'],
          },
        });
        if (elicited.action !== 'accept' || !elicited.content) {
          return toolResult({ cancelled: true, action: elicited.action });
        }
        const provider = String(elicited.content['provider'] ?? 'cloudflare').toLowerCase();
        const hosts = String(elicited.content['hosts'] ?? 'home.example.com');
        const interval = String(elicited.content['intervalMs'] ?? '900000');
        if (!PROVIDER_IDS_LIST.includes(provider)) {
          return toolResult({
            error: `Unsupported provider "${provider}"`,
            action: 'reject-input',
            nextSteps: [`Choose a provider from: ${PROVIDER_IDS_LIST.join(', ')}`],
          });
        }
        return toolResult({
          env: buildEnvContents({ provider, hosts, interval }),
          nextSteps: [
            'Write the template to .env',
            'Fill provider credentials from docs/providers.md',
            'Run validate_config and dry_run before check_once',
          ],
        });
      } catch (error) {
        return toolResult({
          error: error instanceof Error ? error.message : String(error),
          fallback: buildEnvContents({
            provider: 'cloudflare',
            hosts: 'home.example.com',
            interval: '900000',
          }),
          nextSteps: ['Client does not support elicitation; use the fallback template'],
        });
      }
    },
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

  server.registerResource(
    'history',
    MCP_RESOURCE_URIS.history,
    {
      description: 'Recent cycle history (IP changes, errors, dry runs)',
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

  server.registerPrompt(
    MCP_PROMPT_NAMES[2],
    {
      description: 'Propose safe .env and YAML patches for active configuration issues',
    },
    async () => buildFixConfigPrompt(session),
  );

  return Object.assign(server, { dispose });
}
