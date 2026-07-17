/**
 * Orchestrates one IP check + DNS updates for one or more hosts.
 */

import { configForHost } from './hosts.js';
import { discoverPublicIP, formatPublicIP, ipChanged, type PublicIPDiscovery } from './ip.js';
import { createLogger, formatError, type Logger } from './log.js';
import { formatResultSummary } from './result.js';
import { HttpError } from './providers/http.js';
import { createFileStateStore, type HostState, type StateStore } from './state.js';
import type {
  AppConfig,
  CheckResult,
  HostUpdateResult,
  Provider,
  PublicIP,
  UpdateResult,
} from './schemas/provider.js';

export type UpdaterOptions = {
  config: AppConfig;
  provider: Provider;
  discoverPublicIP?: () => Promise<PublicIPDiscovery>;
  getPublicIP?: () => Promise<PublicIP>;
  log?: Logger;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  stateStore?: StateStore;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export function createUpdater(options: UpdaterOptions) {
  const {
    config,
    provider,
    log = createLogger(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
    retryAttempts = 3,
    retryBaseDelayMs = 1_000,
    retryMaxDelayMs = 30_000,
  } = options;
  const stateStore =
    options.stateStore ??
    (config.stateFile ? createFileStateStore(config.stateFile, provider.id) : null);

  const resolveDiscovery =
    options.discoverPublicIP ??
    (options.getPublicIP
      ? async (): Promise<PublicIPDiscovery> => ({
          ip: await options.getPublicIP!(),
          errors: { v4: null, v6: null },
        })
      : discoverPublicIP);

  let currentIP: PublicIP = { v4: null, v6: null };
  let hostState: HostState = {};
  let stateLoaded = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cycle = 0;
  let inFlight = false;
  let inFlightPromise: Promise<CheckResult | null> | null = null;
  let stopping = false;

  async function loadState(): Promise<void> {
    if (stateLoaded) {
      return;
    }
    stateLoaded = true;
    if (!stateStore) {
      return;
    }
    try {
      const loaded = await stateStore.load();
      hostState = Object.fromEntries(
        config.hosts
          .filter((host) => loaded[host] !== undefined)
          .map((host) => [host, loaded[host]!]),
      );
      refreshCurrentIP();
      log.debug('Loaded updater state', { hosts: Object.keys(hostState), currentIP });
    } catch (error) {
      log.warn('Could not load updater state; starting without a checkpoint', formatError(error));
    }
  }

  /**
   * Run one cycle unless the previous one is still in flight. Slow provider
   * APIs must never let cycles overlap: overlapping cycles race on
   * `currentIP` and can issue duplicate or out-of-order provider updates.
   */
  async function checkOnceGuarded(): Promise<CheckResult | null> {
    if (inFlight) {
      log.warn('Skipping check cycle: previous cycle still in progress', { cycle });
      return null;
    }

    inFlight = true;
    const run = checkOnce();
    inFlightPromise = run;
    return await run.finally(() => {
      inFlight = false;
      inFlightPromise = null;
    });
  }

  async function checkOnce(): Promise<CheckResult> {
    await loadState();
    cycle += 1;
    const started = Date.now();
    log.debug(`Starting check cycle #${cycle}`, {
      provider: provider.id,
      hosts: config.hosts,
      previousIP: currentIP,
    });

    const { ip, errors: ipErrors } = await resolveDiscovery();

    if (!ip.v4 && !ip.v6) {
      const message = 'No public IP available; skipping update.';
      log.error(message, {
        cycle,
        ipv4Error: ipErrors.v4,
        ipv6Error: ipErrors.v6,
        hint: 'Check outbound network/DNS access to public-IP lookup services',
      });
      return { status: 'skipped_no_ip', ip, message };
    }

    if (ipErrors.v4 || ipErrors.v6) {
      log.debug('Partial public IP discovery', {
        ip,
        ipv4Error: ipErrors.v4,
        ipv6Error: ipErrors.v6,
      });
    }

    const pendingHosts = config.hosts.filter((host) =>
      ipChanged(ip, hostState[host] ?? { v4: null, v6: null }),
    );

    if (pendingHosts.length === 0) {
      const previousIP = currentIP;
      currentIP = { ...ip };
      const message = 'No update required.';
      log.info(message, {
        cycle,
        ip,
        previousIP,
        durationMs: Date.now() - started,
      });
      return { status: 'unchanged', ip, message };
    }

    log.info(`Updating DNS -> ${formatPublicIP(ip)} for ${pendingHosts.length} host(s)`, {
      cycle,
      provider: `${provider.label} (${provider.id})`,
      hosts: pendingHosts,
      previousIP: currentIP,
      nextIP: ip,
    });

    const hostResults: HostUpdateResult[] = config.hosts
      .filter((host) => !pendingHosts.includes(host))
      .map((host) => ({
        host,
        result: {
          ok: true,
          skipped: true,
          message: `already committed for ${formatPublicIP(ip)}`,
        },
      }));
    let stateChanged = false;

    for (const host of pendingHosts) {
      const hostStarted = Date.now();
      const hostConfig = configForHost(config, host);

      try {
        log.debug(`Updating host ${host}`, {
          hostname: hostConfig.hostname,
          cloudflareRecord: hostConfig.cloudflare.recordName,
          duckdnsDomain: hostConfig.duckdns.domains,
          namecheap: {
            host: hostConfig.namecheap.host,
            domain: hostConfig.namecheap.domain,
          },
          dyndnsHostname: hostConfig.dyndns.hostname,
        });

        const result = await updateWithRetry(hostConfig, ip, host);
        const durationMs = Date.now() - hostStarted;
        hostResults.push({ host, result, durationMs });
        if (result.ok) {
          hostState[host] = { ...ip };
          stateChanged = true;
        }

        const summary = `${formatResultSummary(result)} (${durationMs}ms)`;
        if (result.ok) {
          if (result.skipped) {
            log.info(`[${host}] ${summary}`, result.details);
          } else {
            log.success(`[${host}] ${summary}`, result.details);
          }
        } else {
          log.error(`[${host}] ${summary}`, result.details);
        }
      } catch (error) {
        const durationMs = Date.now() - hostStarted;
        const message = error instanceof Error ? error.message : String(error);
        const result: UpdateResult = {
          ok: false,
          message,
          details: {
            durationMs,
            error: formatError(error),
          },
        };
        hostResults.push({ host, result, durationMs });
        log.error(`[${host}] [error] ${message} (${durationMs}ms)`, formatError(error));
      }
    }

    if (stateChanged && stateStore) {
      try {
        await stateStore.save(hostState);
      } catch (error) {
        log.warn('Could not persist updater state', formatError(error));
      }
    }

    const summary = summarizeHostResults(ip, hostResults, (nextIP) => {
      currentIP = nextIP;
    });
    refreshCurrentIP();

    log.info(`Cycle #${cycle} finished: ${summary.status}`, {
      durationMs: Date.now() - started,
      ok: hostResults.filter(({ result }) => result.ok && !result.skipped).length,
      skipped: hostResults.filter(({ result }) => result.skipped).length,
      failed: hostResults.filter(({ result }) => !result.ok).length,
      hosts: config.hosts.length,
      ip,
      committedIP: summary.status === 'updated' ? ip : currentIP,
    });

    return summary;
  }

  async function start() {
    await loadState();
    log.info(`Using provider: ${provider.label} (${provider.id})`, {
      logLevel: log.level,
      intervalMs: config.interval,
      hosts: config.hosts,
      cloudflare: {
        zoneId: config.cloudflare.zoneId,
        zoneName: config.cloudflare.zoneName,
        proxied: config.cloudflare.proxied,
        ttl: config.cloudflare.ttl,
        createIfMissing: config.cloudflare.createIfMissing,
        hasToken: Boolean(config.cloudflare.apiToken),
      },
    });
    log.info(`Hosts (${config.hosts.length}): ${config.hosts.join(', ')}`);
    log.info(`Check interval: ${config.interval}ms (${formatInterval(config.interval)})`);

    await checkOnceGuarded();
    if (!stopping) {
      timer = setIntervalFn(() => {
        checkOnceGuarded().catch((error: unknown) => {
          log.error('Check cycle failed', formatError(error));
        });
      }, config.interval);
    }

    return {
      async stop() {
        await stop();
      },
    };
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (inFlightPromise) {
      log.info('Waiting for active update cycle to finish');
      await inFlightPromise;
    }
    log.info('Updater stopped');
  }

  function refreshCurrentIP(): void {
    const committed = config.hosts.map((host) => hostState[host]);
    if (
      committed.length === config.hosts.length &&
      committed.every(
        (value) =>
          value !== undefined && value.v4 === committed[0]?.v4 && value.v6 === committed[0]?.v6,
      )
    ) {
      currentIP = { ...committed[0]! };
    }
  }

  async function updateWithRetry(
    hostConfig: AppConfig,
    ip: PublicIP,
    host: string,
  ): Promise<UpdateResult> {
    const attempts = Math.max(1, Math.floor(retryAttempts));
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await provider.update(hostConfig, ip);
        if (!isRetryableResult(result) || attempt >= attempts || stopping) {
          return result;
        }
        await waitBeforeRetry(host, attempt, result.message);
      } catch (error) {
        if (!isRetryableError(error) || attempt >= attempts || stopping) {
          throw error;
        }
        await waitBeforeRetry(
          host,
          attempt,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async function waitBeforeRetry(host: string, attempt: number, reason: string): Promise<void> {
    const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** (attempt - 1));
    const delayMs = Math.max(0, Math.round(exponential * (0.8 + random() * 0.4)));
    log.warn(`Transient update failure for ${host}; retrying`, {
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      reason,
    });
    await sleep(delayMs);
  }

  return {
    checkOnce,
    start,
    stop,
    getCurrentIP(): PublicIP {
      return { ...currentIP };
    },
  };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return true;
  }
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && (status === 429 || status >= 500)) {
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(code);
}

function isRetryableResult(result: UpdateResult): boolean {
  return !result.ok && containsRetryableStatus(result.details);
}

function containsRetryableStatus(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRetryableStatus);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === 'status' || key === 'httpStatus') &&
      typeof nested === 'number' &&
      (nested === 429 || nested >= 500)
    ) {
      return true;
    }
    if (containsRetryableStatus(nested)) {
      return true;
    }
  }
  return false;
}

export function summarizeHostResults(
  ip: PublicIP,
  hostResults: HostUpdateResult[],
  commitIP: (ip: PublicIP) => void,
): CheckResult {
  const messages = hostResults.map(({ host, result }) => `${host}: ${result.message}`);
  const message = messages.join('; ');
  const allOk = hostResults.length > 0 && hostResults.every(({ result }) => result.ok);
  const anyOk = hostResults.some(({ result }) => result.ok);
  const allSkipped =
    hostResults.length > 0 && hostResults.every(({ result }) => result.ok && result.skipped);

  if (allOk) {
    commitIP(ip);
    return {
      status: 'updated',
      ip,
      message: allSkipped ? `All hosts already up to date. ${message}` : message,
      hostResults,
    };
  }

  if (anyOk) {
    return {
      status: 'partial',
      ip,
      message,
      hostResults,
    };
  }

  return {
    status: 'error',
    ip,
    message: message || 'All host updates failed',
    hostResults,
  };
}

function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}
