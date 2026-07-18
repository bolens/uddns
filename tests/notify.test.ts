import { describe, expect, it, vi } from 'vite-plus/test';

import { dispatchNotifications, matchesNotifyFilter } from '../lib/notify.js';
import type { request } from '../lib/providers/http.js';
import type { CycleEvent } from '../lib/schemas/cycle.js';
import { afterEachRestoreMocks } from './helpers/cleanup.js';
import { silentLog } from './helpers/log.js';

afterEachRestoreMocks();

const baseEvent: CycleEvent = {
  at: '2026-01-01T00:00:00.000Z',
  status: 'updated',
  ip: { v4: '203.0.113.10', v6: null },
  message: 'updated',
  durationMs: 5,
  cycle: 1,
};

describe('notifications', () => {
  it('filters change vs error', () => {
    expect(matchesNotifyFilter(baseEvent, ['change'])).toBe(true);
    expect(matchesNotifyFilter({ ...baseEvent, status: 'error' }, ['change'])).toBe(false);
    expect(matchesNotifyFilter({ ...baseEvent, status: 'error' }, ['error'])).toBe(true);
  });

  it('posts webhook and ntfy without failing the cycle on errors', async () => {
    const requestFn = vi
      .fn<typeof request>()
      .mockResolvedValueOnce({
        response: new Response('ok', { status: 200 }),
        body: 'ok',
        meta: {
          method: 'POST',
          url: 'https://example.com/hook',
          status: 200,
          statusText: 'OK',
          durationMs: 1,
          bodyPreview: 'ok',
        },
      })
      .mockRejectedValueOnce(new Error('ntfy down'));

    const log = silentLog();
    await dispatchNotifications(
      {
        webhookUrl: 'https://example.com/hook',
        ntfyUrl: 'https://ntfy.sh/topic',
        on: ['change'],
      },
      baseEvent,
      {
        log,
        requestFn,
        lookupHost: async () => [{ address: '1.1.1.1', family: 4 }],
      },
    );

    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });

  it('posts Slack and Discord payloads and swallows delivery failures', async () => {
    const requestFn = vi
      .fn<typeof request>()
      .mockResolvedValueOnce({
        response: new Response('ok', { status: 200 }),
        body: 'ok',
        meta: {
          method: 'POST',
          url: 'https://hooks.slack.com/services/T/B/X',
          status: 200,
          statusText: 'OK',
          durationMs: 1,
          bodyPreview: 'ok',
        },
      })
      .mockRejectedValueOnce(new Error('discord down'));

    const log = silentLog();
    await dispatchNotifications(
      {
        webhookUrl: null,
        ntfyUrl: null,
        slackUrl: 'https://hooks.slack.com/services/T/B/X',
        discordUrl: 'https://discord.com/api/webhooks/1/2',
        on: ['change'],
      },
      {
        ...baseEvent,
        message: 'updated via https://user:hunter2@provider.example/path?token=sekrit',
      },
      {
        log,
        requestFn,
        lookupHost: async () => [{ address: '1.1.1.1', family: 4 }],
      },
    );

    expect(requestFn).toHaveBeenCalledTimes(2);
    const slackInit = requestFn.mock.calls[0]?.[1];
    expect(typeof slackInit?.body).toBe('string');
    const slackBody = JSON.parse(slackInit?.body as string) as { text: string };
    expect(slackBody.text).toContain('uDDNS updated');
    expect(slackBody.text).not.toContain('hunter2');
    expect(slackBody.text).not.toContain('sekrit');
    expect(log.warn).toHaveBeenCalledWith(
      'Discord notification failed',
      expect.objectContaining({ message: expect.stringContaining('discord down') }),
    );
  });
});
