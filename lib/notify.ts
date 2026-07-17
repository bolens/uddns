/**
 * Outbound change/error notifications (webhook + ntfy).
 */

import { formatError, redact, type Logger } from './log.js';
import { request } from './providers/http.js';
import type { CycleEvent } from './schemas/cycle.js';

export type NotifyConfig = {
  webhookUrl: string | null;
  ntfyUrl: string | null;
  slackUrl?: string | null;
  discordUrl?: string | null;
  on: Array<'change' | 'error'>;
};

export type NotifyDeps = {
  log?: Logger;
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

export async function dispatchNotifications(
  config: NotifyConfig,
  event: CycleEvent,
  deps: NotifyDeps = {},
): Promise<void> {
  if (!matchesNotifyFilter(event, config.on)) {
    return;
  }

  const log = deps.log;
  const payload = redact(event);

  if (config.webhookUrl) {
    try {
      await request(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      log?.warn('Webhook notification failed', formatError(error));
    }
  }

  if (config.ntfyUrl) {
    try {
      const title = `uDDNS ${event.status}`;
      const body = `${event.message} (${event.ip.v4 ?? '-'}/${event.ip.v6 ?? '-'})`;
      await request(config.ntfyUrl, {
        method: 'POST',
        headers: {
          Title: title,
          'Content-Type': 'text/plain',
        },
        body,
      });
    } catch (error) {
      log?.warn('ntfy notification failed', formatError(error));
    }
  }

  const summary = `uDDNS ${event.status}: ${event.message} (${event.ip.v4 ?? '-'}/${event.ip.v6 ?? '-'})`;
  if (config.slackUrl) {
    try {
      await request(config.slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: summary }),
      });
    } catch (error) {
      log?.warn('Slack notification failed', formatError(error));
    }
  }

  if (config.discordUrl) {
    try {
      await request(config.discordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: summary }),
      });
    } catch (error) {
      log?.warn('Discord notification failed', formatError(error));
    }
  }
}
