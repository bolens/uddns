/**
 * Pure MCP tool handlers (no wire-protocol types).
 */

import { discoverPublicIP, type PublicIPDiscovery } from '../ip.js';
import { redact } from '../log.js';
import { listProviders } from '../providers/index.js';
import type { CheckResult } from '../schemas/provider.js';
import type { UpdaterStatus } from '../updater.js';
import type { McpSession } from './session.js';

export type McpToolHandlers = {
  listProviders: () => Array<{ id: string; label: string }>;
  getPublicIp: () => Promise<PublicIPDiscovery>;
  getConfig: () => unknown;
  checkOnce: () => Promise<CheckResult | null>;
  forceUpdate: () => Promise<CheckResult | null>;
  dryRun: () => Promise<CheckResult | null>;
  getStatus: () => UpdaterStatus;
  getHistory: () => Promise<unknown>;
  setInterval: (intervalMs: number) => UpdaterStatus;
  startLoop: () => Promise<UpdaterStatus>;
  stopLoop: () => Promise<UpdaterStatus>;
};

export function createToolHandlers(
  session: McpSession,
  options: {
    discoverPublicIPFn?: () => Promise<PublicIPDiscovery>;
  } = {},
): McpToolHandlers {
  const discover = options.discoverPublicIPFn ?? discoverPublicIP;

  return {
    listProviders() {
      return listProviders().map(({ id, label }) => ({ id, label }));
    },

    async getPublicIp() {
      return await discover();
    },

    getConfig() {
      return redact(session.config);
    },

    async checkOnce() {
      return await session.updater.checkOnceGuarded();
    },

    async forceUpdate() {
      return await session.updater.checkOnceGuarded({ force: true });
    },

    async dryRun() {
      return await session.updater.checkOnceGuarded({ dryRun: true });
    },

    getStatus() {
      return session.updater.getStatus();
    },

    async getHistory() {
      const store = session.history ?? null;
      if (!store) {
        return { events: [] };
      }
      return { events: await store.load() };
    },

    setInterval(intervalMs: number) {
      session.updater.setIntervalMs(intervalMs);
      return session.updater.getStatus();
    },

    async startLoop() {
      await session.updater.start();
      return session.updater.getStatus();
    },

    async stopLoop() {
      await session.updater.stop();
      return session.updater.getStatus();
    },
  };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
