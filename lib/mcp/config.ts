/**
 * MCP server transport / bind configuration (separate from AppConfig).
 */

import { DEFAULT_MCP_HOST, DEFAULT_MCP_PORT, DEFAULT_MCP_TRANSPORT } from '../defaults.js';

export type McpTransport = 'stdio' | 'http';

export type McpConfig = {
  transport: McpTransport;
  host: string;
  port: number;
  authToken: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
};

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

/**
 * Load MCP bind/auth settings from the environment (and optional argv override).
 */
export function loadMcpConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { transportOverride?: McpTransport | null } = {},
): McpConfig {
  const transportRaw = (
    options.transportOverride ??
    env['UDDNS_MCP_TRANSPORT'] ??
    DEFAULT_MCP_TRANSPORT
  ).toLowerCase();

  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw new Error('UDDNS_MCP_TRANSPORT must be "stdio" or "http"');
  }

  const host = env['UDDNS_MCP_HOST']?.trim() || DEFAULT_MCP_HOST;
  const portRaw = env['UDDNS_MCP_PORT'] ?? String(DEFAULT_MCP_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('UDDNS_MCP_PORT must be an integer between 1 and 65535');
  }

  const authToken = env['UDDNS_MCP_AUTH_TOKEN']?.trim() || null;
  const tlsCert = env['UDDNS_MCP_TLS_CERT']?.trim() || null;
  const tlsKey = env['UDDNS_MCP_TLS_KEY']?.trim() || null;

  if ((tlsCert == null) !== (tlsKey == null)) {
    throw new Error('UDDNS_MCP_TLS_CERT and UDDNS_MCP_TLS_KEY must be set together');
  }

  if (transportRaw === 'http' && !isLoopbackHost(host)) {
    if (!authToken) {
      throw new Error('UDDNS_MCP_AUTH_TOKEN is required when UDDNS_MCP_HOST is not loopback');
    }
    if (!tlsCert || !tlsKey) {
      throw new Error(
        'UDDNS_MCP_TLS_CERT and UDDNS_MCP_TLS_KEY are required when UDDNS_MCP_HOST is not loopback',
      );
    }
  }

  return {
    transport: transportRaw,
    host,
    port,
    authToken,
    tlsCert,
    tlsKey,
  };
}

export function isLoopbackMcpHost(host: string): boolean {
  return isLoopbackHost(host);
}
