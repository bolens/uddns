/**
 * Entry point for the uDDNS updater daemon.
 */

import { pathToFileURL } from 'node:url';

import { resolveAccounts, type LoadedAccount } from './lib/config-file.js';
import { loadHealthConfig, type HealthConfig } from './lib/health-config.js';
import { createLogger, formatError, type Logger } from './lib/log.js';
import { getProvider } from './lib/providers/index.js';
import { createRuntimeBundle, type RuntimeBundle } from './lib/runtime.js';
import type { AppConfig, Provider } from './lib/schemas/provider.js';
import { startSideServer, type SideServer } from './lib/side-server.js';
import { createUpdater, type Updater, type UpdaterOptions } from './lib/updater.js';

export type AppOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  log?: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  resolveAccountsFn?: (
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => LoadedAccount[] | Promise<LoadedAccount[]>;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
  on?: (event: string, listener: (value?: unknown) => void) => void;
  exit?: (code: number) => void;
};

export async function main(options: AppOptions = {}): Promise<void> {
  const log = options.log ?? createLogger();
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const on =
    options.on ??
    ((event: string, listener: (value?: unknown) => void) => {
      process.on(event, listener);
    });
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const resolveAccountsFn =
    options.resolveAccountsFn ??
    (options.loadConfigFn
      ? (resolveEnv: NodeJS.ProcessEnv | Record<string, string | undefined>) => [
          { id: 'default', config: options.loadConfigFn!(resolveEnv) },
        ]
      : resolveAccounts);

  let bundles: RuntimeBundle[] = [];
  let sideServer: SideServer | null = null;
  let activeHealthConfig: HealthConfig | null = null;
  let shuttingDown = false;
  let reloading = false;
  const eventListeners = new Set<(event: import('./lib/schemas/cycle.js').CycleEvent) => void>();

  async function shutdown(signal: string, code: number): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`Received ${signal}; shutting down.`);
    try {
      await Promise.all(bundles.map((bundle) => bundle.updater.stop()));
      if (sideServer) {
        await sideServer.close();
        sideServer = null;
      }
    } catch (error) {
      log.error('Graceful shutdown failed', formatError(error));
      code = 1;
    }
    exit(code);
  }

  function buildBundles(accounts: LoadedAccount[]): RuntimeBundle[] {
    return accounts.map((account) => {
      const bundle = createRuntimeBundle({
        config: account.config,
        log,
        accountId: account.id,
        getProviderFn,
        createUpdaterFn: options.createUpdaterFn ?? createUpdater,
      });
      bundle.eventListeners.add((event) => {
        for (const listener of eventListeners) {
          listener(event);
        }
      });
      return bundle;
    });
  }

  async function startAccounts(accounts: LoadedAccount[]): Promise<void> {
    bundles = buildBundles(accounts);
    await Promise.all(bundles.map((bundle) => bundle.updater.start()));
  }

  function healthConfigMatches(left: HealthConfig | null, right: HealthConfig): boolean {
    return (
      left !== null &&
      left.enabled === right.enabled &&
      left.host === right.host &&
      left.port === right.port &&
      left.metricsEnabled === right.metricsEnabled
    );
  }

  async function reconcileSideServer(): Promise<void> {
    const health = loadHealthConfig(env);
    if (healthConfigMatches(activeHealthConfig, health)) {
      return;
    }
    if (sideServer) {
      await sideServer.close();
      sideServer = null;
    }
    activeHealthConfig = health;
    if (!health.enabled) {
      return;
    }
    sideServer = await startSideServer({
      config: {
        host: health.host,
        port: health.port,
        metricsEnabled: health.metricsEnabled,
      },
      getStatus: () => {
        if (bundles.length === 1) {
          return bundles[0]!.updater.getStatus();
        }
        return {
          accounts: bundles.map((bundle) => ({
            id: bundle.updater.getStatus().accountId ?? 'unknown',
            status: bundle.updater.getStatus(),
          })),
        };
      },
      getMetrics: () => {
        const merged = {
          cyclesTotal: {} as Record<string, number>,
          updatesTotal: 0,
          discoverErrors: 0,
          lastSuccessAt: null as string | null,
        };
        for (const bundle of bundles) {
          const snap = bundle.metrics.snapshot();
          for (const [status, count] of Object.entries(snap.cyclesTotal)) {
            merged.cyclesTotal[status] = (merged.cyclesTotal[status] ?? 0) + count;
          }
          merged.updatesTotal += snap.updatesTotal;
          merged.discoverErrors += snap.discoverErrors;
          if (
            snap.lastSuccessAt &&
            (!merged.lastSuccessAt || snap.lastSuccessAt > merged.lastSuccessAt)
          ) {
            merged.lastSuccessAt = snap.lastSuccessAt;
          }
        }
        return merged;
      },
      onEventSubscribe: (listener) => {
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
        };
      },
    });
    log.info(`Health server listening on ${sideServer.url}`);
  }

  async function reload(): Promise<void> {
    if (reloading || shuttingDown) {
      return;
    }
    reloading = true;
    log.info('Received SIGHUP; reloading configuration');
    try {
      const wasRunning = bundles.some((bundle) => bundle.updater.getStatus().running);
      await Promise.all(bundles.map((bundle) => bundle.updater.stop()));
      const accounts = await resolveAccountsFn(env);
      await startAccounts(accounts);
      await reconcileSideServer();
      if (!wasRunning) {
        await Promise.all(bundles.map((bundle) => bundle.updater.stop()));
      }
      log.success(`Reloaded ${accounts.length} account(s)`);
    } catch (error) {
      log.error('Configuration reload failed', formatError(error));
    } finally {
      reloading = false;
    }
  }

  try {
    const accounts = await resolveAccountsFn(env);
    if (argv.includes('--check-config')) {
      for (const account of accounts) {
        const provider = getProviderFn(account.config.provider);
        log.success(
          `Configuration is valid for ${provider.label} (${provider.id})` +
            (account.id !== 'default' ? ` [${account.id}]` : ''),
        );
      }
      return;
    }

    await startAccounts(accounts);
    await reconcileSideServer();

    on('SIGINT', () => {
      void shutdown('SIGINT', 0);
    });
    on('SIGTERM', () => {
      void shutdown('SIGTERM', 0);
    });
    on('SIGHUP', () => {
      void reload();
    });

    on('uncaughtException', (error) => {
      log.error('Uncaught exception; exiting', formatError(error));
      void shutdown('uncaughtException', 1);
    });
    on('unhandledRejection', (reason) => {
      log.error('Unhandled promise rejection; exiting', formatError(reason));
      void shutdown('unhandledRejection', 1);
    });
  } catch (error) {
    log.error('Failed to start updater', formatError(error));
    exit(1);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  /* v8 ignore next: only runs when executed as the main script, never under test */
  await main();
}
