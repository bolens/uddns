/**
 * Shared wiring for updater + history + notify + metrics + IP policy.
 */

import dns from 'node:dns/promises';

import { applyIpPolicy } from './ip-policy.js';
import { discoverPublicIP } from './ip.js';
import { createFileHistoryStore, type HistoryStore } from './history.js';
import { createLogger, formatError, type Logger } from './log.js';
import { dispatchNotifications } from './notify.js';
import { getProvider } from './providers/index.js';
import type { request } from './providers/http.js';
import type { CycleEvent } from './schemas/cycle.js';
import type { AppConfig, Provider } from './schemas/provider.js';
import { createMetricsTracker } from './side-server.js';
import { createTelemetry } from './telemetry.js';
import { createUpdater, type Updater, type UpdaterOptions } from './updater.js';

export type RuntimeBundle = {
  config: AppConfig;
  provider: Provider;
  updater: Updater;
  history: HistoryStore | null;
  metrics: ReturnType<typeof createMetricsTracker>;
  eventListeners: Set<(event: CycleEvent) => void>;
  /** Await in-flight notification dispatches (once exit / graceful shutdown). */
  flushNotifications: () => Promise<void>;
};

function createDefaultResolver() {
  const resolver = new dns.Resolver();
  return {
    setServers: (servers: string[]) => {
      resolver.setServers(servers);
    },
    resolve4: (hostname: string) => resolver.resolve4(hostname),
    resolve6: (hostname: string) => resolver.resolve6(hostname),
    resolveTxt: (hostname: string) => resolver.resolveTxt(hostname),
  };
}

export function createRuntimeBundle(options: {
  config: AppConfig;
  log?: Logger;
  accountId?: string;
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
  getProviderFn?: (id: string) => Provider;
  /** Test override for IP discovery HTTP (skips pin dial). */
  discoverFetch?: typeof globalThis.fetch;
  /** Test override for notification HTTP. */
  notifyRequestFn?: typeof request;
}): RuntimeBundle {
  const log = options.log ?? createLogger();
  const provider = (options.getProviderFn ?? getProvider)(options.config.provider);
  const history = options.config.historyFile
    ? createFileHistoryStore(options.config.historyFile)
    : null;
  const metrics = createMetricsTracker();
  const eventListeners = new Set<(event: CycleEvent) => void>();
  const pendingNotifications = new Set<Promise<void>>();

  const createUpdaterFn = options.createUpdaterFn ?? createUpdater;
  const telemetry = createTelemetry(options.config.telemetryEnabled);
  const discoverDeps: Parameters<typeof discoverPublicIP>[0] = {
    createResolver: createDefaultResolver,
    timeoutMs: options.config.ipTimeoutMs,
    dnsFallback: options.config.ipDnsFallback,
  };
  if (options.config.ipHttpsV4) {
    discoverDeps.httpsV4 = options.config.ipHttpsV4;
  }
  if (options.config.ipHttpsV6) {
    discoverDeps.httpsV6 = options.config.ipHttpsV6;
  }
  if (options.discoverFetch) {
    discoverDeps.fetch = options.discoverFetch;
  }

  const updaterOptions: UpdaterOptions = {
    config: options.config,
    provider,
    log,
    telemetry,
    applyIpPolicy: (discovered, previous) =>
      applyIpPolicy(discovered, previous, {
        family: options.config.ipFamily,
        missing: options.config.ipMissing,
      }),
    discoverPublicIP: () => discoverPublicIP(discoverDeps),
    async onCycleComplete(event) {
      metrics.record(event);
      if (history) {
        try {
          await history.append(event);
        } catch (error) {
          log.warn('Could not append history', formatError(error));
        }
      }
      const notify = dispatchNotifications(
        {
          webhookUrl: options.config.notifyWebhookUrl,
          ntfyUrl: options.config.notifyNtfyUrl,
          slackUrl: options.config.notifySlackUrl,
          discordUrl: options.config.notifyDiscordUrl,
          on: options.config.notifyOn,
        },
        event,
        {
          log,
          ...(options.notifyRequestFn ? { requestFn: options.notifyRequestFn } : {}),
        },
      ).catch((error: unknown) => {
        log.warn('Notification dispatch failed', formatError(error));
      });
      pendingNotifications.add(notify);
      void notify.finally(() => {
        pendingNotifications.delete(notify);
      });
      for (const listener of eventListeners) {
        listener(event);
      }
    },
  };
  if (options.accountId !== undefined) {
    updaterOptions.accountId = options.accountId;
  }
  const updater = createUpdaterFn(updaterOptions);

  return {
    config: options.config,
    provider,
    updater,
    history,
    metrics,
    eventListeners,
    async flushNotifications() {
      await Promise.allSettled(pendingNotifications);
    },
  };
}
