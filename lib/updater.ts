/**
 * Orchestrates one IP check + DNS updates for one or more hosts.
 */

import { configForHost } from './hosts.js';
import { discoverPublicIP, formatPublicIP, ipChanged, type PublicIPDiscovery } from './ip.js';
import { createLogger, formatError, type Logger } from './log.js';
import { formatResultSummary } from './result.js';
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
};

export function createUpdater(options: UpdaterOptions) {
  const {
    config,
    provider,
    log = createLogger(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const resolveDiscovery =
    options.discoverPublicIP ??
    (options.getPublicIP
      ? async (): Promise<PublicIPDiscovery> => ({
          ip: await options.getPublicIP!(),
          errors: { v4: null, v6: null },
        })
      : discoverPublicIP);

  let currentIP: PublicIP = { v4: null, v6: null };
  let timer: ReturnType<typeof setInterval> | null = null;
  let cycle = 0;
  let inFlight = false;

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
    try {
      return await checkOnce();
    } finally {
      inFlight = false;
    }
  }

  async function checkOnce(): Promise<CheckResult> {
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

    if (!ipChanged(ip, currentIP)) {
      const message = 'No update required.';
      log.info(message, {
        cycle,
        ip,
        previousIP: currentIP,
        durationMs: Date.now() - started,
      });
      return { status: 'unchanged', ip, message };
    }

    log.info(`Updating DNS -> ${formatPublicIP(ip)} for ${config.hosts.length} host(s)`, {
      cycle,
      provider: `${provider.label} (${provider.id})`,
      hosts: config.hosts,
      previousIP: currentIP,
      nextIP: ip,
    });

    const hostResults: HostUpdateResult[] = [];

    for (const host of config.hosts) {
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

        const result = await provider.update(hostConfig, ip);
        const durationMs = Date.now() - hostStarted;
        hostResults.push({ host, result, durationMs });

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

    const summary = summarizeHostResults(ip, hostResults, (nextIP) => {
      currentIP = nextIP;
    });

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
    timer = setIntervalFn(() => {
      checkOnceGuarded().catch((error: unknown) => {
        log.error('Check cycle failed', formatError(error));
      });
    }, config.interval);

    return {
      stop() {
        if (timer != null) {
          clearIntervalFn(timer);
          timer = null;
          log.info('Updater stopped');
        }
      },
    };
  }

  return {
    checkOnce,
    start,
    getCurrentIP(): PublicIP {
      return { ...currentIP };
    },
  };
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
