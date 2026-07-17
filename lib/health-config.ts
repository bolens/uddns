/**
 * Process-level health / metrics bind settings.
 */

import { DEFAULT_HEALTH_HOST, DEFAULT_HEALTH_PORT } from './defaults.js';

export type HealthConfig = {
  enabled: boolean;
  host: string;
  port: number;
  metricsEnabled: boolean;
  authToken: string | null;
};

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function loadHealthConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): HealthConfig {
  const portRaw = env['UDDNS_HEALTH_PORT'] ?? String(DEFAULT_HEALTH_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('UDDNS_HEALTH_PORT must be an integer between 0 and 65535');
  }
  const host = env['UDDNS_HEALTH_HOST']?.trim() || DEFAULT_HEALTH_HOST;
  const authToken = env['UDDNS_HEALTH_AUTH_TOKEN']?.trim() || null;
  const enabled = parseBoolean('UDDNS_HEALTH', env['UDDNS_HEALTH'], false);
  if (enabled && !isLoopbackHost(host) && !authToken) {
    throw new Error('UDDNS_HEALTH_AUTH_TOKEN is required when UDDNS_HEALTH_HOST is not loopback');
  }
  return {
    enabled,
    host,
    port,
    metricsEnabled: parseBoolean('UDDNS_METRICS', env['UDDNS_METRICS'], false),
    authToken,
  };
}
