/**
 * Outbound change/error notifications (webhook + ntfy).
 */

import { formatError, redact, type Logger } from './log.js';
import { request } from './providers/http.js';
import type { CycleEvent } from './schemas/cycle.js';
import type { HostLookupFn, HttpsUrlPolicy } from './url-policy.js';

export type NotifyConfig = {
  webhookUrl: string | null;
  ntfyUrl: string | null;
  slackUrl?: string | null;
  discordUrl?: string | null;
  on: Array<'change' | 'error'>;
};

export type NotifyDeps = {
  log?: Logger;
  lookupHost?: HostLookupFn;
  /** Override outbound HTTP (tests). Production uses pinned `request`. */
  requestFn?: typeof request;
};

export function matchesNotifyFilter(event: CycleEvent, on: NotifyConfig['on']): boolean {
  if (on.includes('change') && event.status === 'updated') {
    return true;
  }
  if (on.includes('error') && (event.status === 'error' || event.status === 'partial')) {
    return true;
  }
  return false;
}

function notifyPin(
  policy: HttpsUrlPolicy,
  lookupHost?: HostLookupFn,
): {
  policy: HttpsUrlPolicy;
  lookupHost?: HostLookupFn;
} {
  return lookupHost ? { policy, lookupHost } : { policy };
}

export async function dispatchNotifications(
  config: NotifyConfig,
  event: CycleEvent,
  deps: NotifyDeps = {},
): Promise<void> {
  if (!matchesNotifyFilter(event, config.on)) {
    return;
  }

  const log = deps.log;
  const httpRequest = deps.requestFn ?? request;
  const payload = redact(event) as CycleEvent;
  const safeMessage = typeof payload.message === 'string' ? payload.message : '[redacted]';
  const ipLabel = `${payload.ip.v4 ?? '-'}/${payload.ip.v6 ?? '-'}`;

  if (config.webhookUrl) {
    try {
      await httpRequest(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        pin: notifyPin({ allowPrivateHosts: true }, deps.lookupHost),
      });
    } catch (error) {
      log?.warn('Webhook notification failed', formatError(error));
    }
  }

  if (config.ntfyUrl) {
    try {
      const title = `uDDNS ${payload.status}`;
      const body = `${safeMessage} (${ipLabel})`;
      await httpRequest(config.ntfyUrl, {
        method: 'POST',
        headers: {
          Title: title,
          'Content-Type': 'text/plain',
        },
        body,
        pin: notifyPin({ allowPrivateHosts: true }, deps.lookupHost),
      });
    } catch (error) {
      log?.warn('ntfy notification failed', formatError(error));
    }
  }

  const summary = `uDDNS ${payload.status}: ${safeMessage} (${ipLabel})`;
  if (config.slackUrl) {
    try {
      await httpRequest(config.slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: summary }),
        pin: notifyPin({}, deps.lookupHost),
      });
    } catch (error) {
      log?.warn('Slack notification failed', formatError(error));
    }
  }

  if (config.discordUrl) {
    try {
      await httpRequest(config.discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: summary }),
        pin: notifyPin({}, deps.lookupHost),
      });
    } catch (error) {
      log?.warn('Discord notification failed', formatError(error));
    }
  }
}
