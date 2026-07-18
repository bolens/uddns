/**
 * Orchestrates one IP check + DNS updates for one or more hosts.
 */

import { errorMessage, getErrorProp } from './errors.js';
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS } from './defaults.js';
import { configForHost } from './hosts.js';
import {
  discoverPublicIP,
  formatPublicIP,
  ipChanged,
  mergePresentFamilies,
  type PublicIPDiscovery,
} from './ip.js';
import { createLogger, formatError, type Logger } from './log.js';
import { normalizeDnsName } from './providers/domain-host.js';
import { HttpError } from './providers/http.js';
import { formatResultSummary } from './result.js';
import { cycleEventFromResult, type CycleEvent } from './schemas/cycle.js';
import type {
  AppConfig,
  CheckResult,
  HostUpdateResult,
  Provider,
  PublicIP,
  UpdateResult,
} from './schemas/provider.js';
import { createFileStateStore, type HostState, type StateStore } from './state.js';
import type { Telemetry } from './telemetry.js';

type CheckOnceOptions = {
  force?: boolean;
  dryRun?: boolean;
  hosts?: string[];
};

export type BusyCheckResult = {
  status: 'busy';
  message: string;
  cycle: number;
  ip: PublicIP;
};

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
  onCycleComplete?: (event: CycleEvent) => void | Promise<void>;
  accountId?: string;
  /** Apply IP family / missing-family policy after discovery. */
  applyIpPolicy?: (discovered: PublicIP, previous: PublicIP) => PublicIP;
  now?: () => number;
  telemetry?: Telemetry;
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
    onCycleComplete,
    accountId,
    applyIpPolicy,
    now = Date.now,
    telemetry,
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
  let intervalMs = config.interval;
  let cycle = 0;
  let inFlight = false;
  let inFlightPromise: Promise<CheckResult | null> | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let lastCycle: CycleEvent | null = null;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let nextRetryAt: string | null = null;

  function scheduleTimer(): void {
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (stopping) {
      return;
    }
    timer = setIntervalFn(() => {
      checkOnceGuarded().catch((error: unknown) => {
        log.error('Check cycle failed', formatError(error));
      });
    }, intervalMs);
  }

  async function emitCycleComplete(
    result: CheckResult,
    durationMs: number,
    discoveryErrors?: PublicIPDiscovery['errors'],
  ): Promise<CheckResult> {
    const meta: Parameters<typeof cycleEventFromResult>[1] = {
      cycle,
      durationMs,
      at: new Date(now()).toISOString(),
    };
    if (result.forced !== undefined) {
      meta.forced = result.forced;
    }
    if (result.dryRun !== undefined) {
      meta.dryRun = result.dryRun;
    }
    if (accountId !== undefined) {
      meta.accountId = accountId;
    }
    if (discoveryErrors?.v4 || discoveryErrors?.v6) {
      meta.discoveryErrors = {
        v4: discoveryErrors.v4 !== null,
        v6: discoveryErrors.v6 !== null,
      };
    }
    const event = cycleEventFromResult(result, meta);
    lastCycle = event;
    if ((result.status === 'updated' || result.status === 'unchanged') && !result.dryRun) {
      lastSuccessAt = event.at;
      lastError = null;
    }
    if (result.status === 'error' || result.status === 'partial') {
      lastError = result.message;
    }
    nextRetryAt = null;
    if (onCycleComplete) {
      try {
        await onCycleComplete(event);
      } catch (error) {
        log.warn('onCycleComplete handler failed', formatError(error));
      }
    }
    return result;
  }

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
  async function checkOnceGuarded(
    checkOptions: CheckOnceOptions = {},
  ): Promise<CheckResult | BusyCheckResult> {
    if (inFlight) {
      log.warn('Skipping check cycle: previous cycle still in progress', { cycle });
      return {
        status: 'busy',
        message: 'Previous cycle still in progress',
        cycle,
        ip: { ...currentIP },
      };
    }

    inFlight = true;
    const run = checkOnce(checkOptions);
    inFlightPromise = run;
    return await run.finally(() => {
      inFlight = false;
      inFlightPromise = null;
    });
  }

  async function checkOnce(checkOptions: CheckOnceOptions = {}): Promise<CheckResult> {
    const forced = Boolean(checkOptions.force);
    const dryRun = Boolean(checkOptions.dryRun);
    const enabledHosts = config.hosts.filter((host) => !config.disabledHosts.includes(host));
    const targetHosts = checkOptions.hosts
      ? [...new Set(checkOptions.hosts.map((host) => normalizeDnsName(host.trim())))]
      : enabledHosts;
    const unknownHosts = targetHosts.filter((host) => !config.hosts.includes(host));
    if (targetHosts.length === 0) {
      throw new Error('At least one host must be selected');
    }
    if (unknownHosts.length > 0) {
      throw new Error(`Unknown configured host(s): ${unknownHosts.join(', ')}`);
    }
    const disabledTargets = targetHosts.filter((host) => config.disabledHosts.includes(host));
    if (disabledTargets.length > 0) {
      throw new Error(`Disabled host(s) cannot be updated: ${disabledTargets.join(', ')}`);
    }
    await loadState();
    cycle += 1;
    const started = now();
    log.debug(`Starting check cycle #${cycle}`, {
      provider: provider.id,
      hosts: targetHosts,
      previousIP: currentIP,
      forced,
      dryRun,
    });

    const discovery = telemetry
      ? await telemetry.trace('uddns.ip.discover', { 'uddns.cycle': cycle }, resolveDiscovery)
      : await resolveDiscovery();
    let ip = discovery.ip;
    const ipErrors = discovery.errors;

    if (applyIpPolicy) {
      ip = applyIpPolicy(ip, currentIP);
    }

    if (!ip.v4 && !ip.v6) {
      const message = 'No public IP available; skipping update.';
      log.error(message, {
        cycle,
        ipv4Error: ipErrors.v4,
        ipv6Error: ipErrors.v6,
        hint: 'Check outbound network/DNS access to public-IP lookup services',
      });
      return await emitCycleComplete(
        { status: 'skipped_no_ip', ip, message, forced, dryRun },
        now() - started,
        ipErrors,
      );
    }

    if (ipErrors.v4 || ipErrors.v6) {
      log.debug('Partial public IP discovery', {
        ip,
        ipv4Error: ipErrors.v4,
        ipv6Error: ipErrors.v6,
      });
    }

    const pendingHosts = forced
      ? [...targetHosts]
      : targetHosts.filter((host) => ipChanged(ip, hostState[host] ?? { v4: null, v6: null }));

    if (pendingHosts.length === 0) {
      const previousIP = currentIP;
      if (!dryRun) {
        currentIP = mergePresentFamilies(currentIP, ip);
      }
      const message = 'No update required.';
      log.info(message, {
        cycle,
        ip,
        previousIP,
        durationMs: now() - started,
      });
      return await emitCycleComplete(
        { status: 'unchanged', ip, message, forced, dryRun },
        now() - started,
        ipErrors,
      );
    }

    if (dryRun) {
      const hostResults: HostUpdateResult[] = pendingHosts.map((host) => ({
        host,
        result: {
          ok: true,
          skipped: true,
          message: `would update ${host} -> ${formatPublicIP(ip)}`,
        },
      }));
      const message = `Dry run: would update ${pendingHosts.length} host(s) -> ${formatPublicIP(ip)}`;
      log.info(message, { cycle, hosts: pendingHosts, nextIP: ip, forced });
      return await emitCycleComplete(
        { status: 'dry_run', ip, message, hostResults, forced, dryRun: true },
        now() - started,
        ipErrors,
      );
    }

    log.info(`Updating DNS -> ${formatPublicIP(ip)} for ${pendingHosts.length} host(s)`, {
      cycle,
      provider: `${provider.label} (${provider.id})`,
      hosts: pendingHosts,
      previousIP: currentIP,
      nextIP: ip,
      forced,
    });

    const hostResults: HostUpdateResult[] = targetHosts
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
      const hostStarted = now();
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
        const durationMs = now() - hostStarted;
        hostResults.push({ host, result, durationMs });
        if (result.ok) {
          hostState[host] = mergePresentFamilies(hostState[host] ?? { v4: null, v6: null }, ip);
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
        const durationMs = now() - hostStarted;
        const message = errorMessage(error);
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
      currentIP = mergePresentFamilies(currentIP, nextIP);
    });
    summary.forced = forced;
    summary.dryRun = false;
    refreshCurrentIP();

    log.info(`Cycle #${cycle} finished: ${summary.status}`, {
      durationMs: now() - started,
      ok: hostResults.filter(({ result }) => result.ok && !result.skipped).length,
      skipped: hostResults.filter(({ result }) => result.skipped).length,
      failed: hostResults.filter(({ result }) => !result.ok).length,
      hosts: targetHosts.length,
      ip,
      committedIP: summary.status === 'updated' || summary.status === 'unchanged' ? ip : currentIP,
    });

    return await emitCycleComplete(summary, now() - started, ipErrors);
  }

  async function start() {
    if (stopPromise) {
      await stopPromise;
    }
    stopping = false;
    if (timer != null) {
      return {
        async stop() {
          await stop();
        },
      };
    }

    await loadState();
    log.info(`Using provider: ${provider.label} (${provider.id})`, {
      logLevel: log.level,
      intervalMs,
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
    log.info(`Check interval: ${intervalMs}ms (${formatInterval(intervalMs)})`);

    await checkOnceGuarded();
    if (!stopping) {
      scheduleTimer();
    }

    return {
      async stop() {
        await stop();
      },
    };
  }

  async function stop(): Promise<void> {
    if (stopPromise) {
      await stopPromise;
      return;
    }
    stopping = true;
    stopPromise = (async () => {
      if (timer != null) {
        clearIntervalFn(timer);
        timer = null;
      }
      if (inFlightPromise) {
        log.info('Waiting for active update cycle to finish');
        await inFlightPromise;
      }
      log.info('Updater stopped');
    })();
    try {
      await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  function setIntervalMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
      throw new Error(
        `intervalMs must be a number of milliseconds from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`,
      );
    }
    intervalMs = ms;
    if (timer != null) {
      scheduleTimer();
      log.info(`Check interval updated: ${intervalMs}ms (${formatInterval(intervalMs)})`);
    }
  }

  function getStatus() {
    return {
      running: timer != null,
      stopping,
      intervalMs,
      currentIP: { ...currentIP },
      cycle,
      inFlight,
      hosts: Object.fromEntries(Object.entries(hostState).map(([host, ip]) => [host, { ...ip }])),
      lastCycle,
      lastSuccessAt,
      lastError,
      nextRetryAt,
      accountId: accountId ?? null,
    };
  }

  function refreshCurrentIP(): void {
    const enabledHosts = config.hosts.filter((host) => !config.disabledHosts.includes(host));
    const committed = enabledHosts.map((host) => hostState[host]);
    if (
      enabledHosts.length > 0 &&
      committed.length === enabledHosts.length &&
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
        const update = () => provider.update(hostConfig, ip);
        const result = telemetry
          ? await telemetry.trace(
              'uddns.provider.update',
              {
                'uddns.provider': provider.id,
                'uddns.host': host,
                'uddns.attempt': attempt,
              },
              update,
            )
          : await update();
        if (!isRetryableResult(result) || attempt >= attempts || stopping) {
          return result;
        }
        await waitBeforeRetry(
          host,
          attempt,
          result.message,
          findNumericField(result.details, 'retryAfterMs'),
        );
      } catch (error) {
        if (!isRetryableError(error) || attempt >= attempts || stopping) {
          throw error;
        }
        await waitBeforeRetry(
          host,
          attempt,
          errorMessage(error),
          findNumericField(error, 'retryAfterMs') ??
            findNumericField(getErrorProp(error, 'details'), 'retryAfterMs'),
        );
      }
    }
  }

  async function waitBeforeRetry(
    host: string,
    attempt: number,
    reason: string,
    retryAfterMs: number | null = null,
  ): Promise<void> {
    const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** (attempt - 1));
    const delayMs =
      retryAfterMs === null
        ? Math.max(0, Math.round(exponential * (0.8 + random() * 0.4)))
        : Math.max(0, Math.min(retryMaxDelayMs, Math.round(retryAfterMs)));
    nextRetryAt = new Date(now() + delayMs).toISOString();
    log.warn(`Transient update failure for ${host}; retrying`, {
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      reason,
    });
    if (!stopping) {
      await sleep(delayMs);
    }
  }

  return {
    checkOnce,
    checkOnceGuarded,
    start,
    stop,
    setIntervalMs,
    getStatus,
    getCurrentIP(): PublicIP {
      return { ...currentIP };
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
export type UpdaterStatus = ReturnType<Updater['getStatus']>;

export function isRetryableHttpStatus(status: unknown): boolean {
  return typeof status === 'number' && (status === 429 || status >= 500);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return true;
  }
  if (isRetryableHttpStatus(getErrorProp(error, 'status'))) {
    return true;
  }
  const code = getErrorProp<string | number>(error, 'code');
  if (typeof code !== 'string' && typeof code !== 'number') {
    return false;
  }
  return ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(
    String(code),
  );
}

function isRetryableResult(result: UpdateResult): boolean {
  if (result.ok) {
    return false;
  }
  if (
    result.details &&
    typeof result.details === 'object' &&
    result.details['retryable'] === true
  ) {
    return true;
  }
  return containsRetryableStatus(result.details);
}

function containsRetryableStatus(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRetryableStatus);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'status' || key === 'httpStatus') && isRetryableHttpStatus(nested)) {
      return true;
    }
    if (containsRetryableStatus(nested)) {
      return true;
    }
  }
  return false;
}

function findNumericField(value: unknown, field: string): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericField(item, field);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === field && typeof nested === 'number' && Number.isFinite(nested)) {
      return nested;
    }
    const found = findNumericField(nested, field);
    if (found !== null) {
      return found;
    }
  }
  return null;
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
    if (allSkipped) {
      return {
        status: 'unchanged',
        ip,
        message: `All hosts already up to date. ${message}`,
        hostResults,
      };
    }
    return {
      status: 'updated',
      ip,
      message,
      hostResults,
    };
  }

  if (anyOk) {
    // Advance the policy baseline so keep+discovery-blip cannot regress hosts
    // that already accepted this cycle's IP.
    commitIP(ip);
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
