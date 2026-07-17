import { describe, expect, it, vi } from 'vite-plus/test';

import { dispatchNotifications, matchesNotifyFilter } from '../lib/notify.js';
import type { CycleEvent } from '../lib/schemas/cycle.js';
import { silentLog } from './helpers/log.js';

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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockRejectedValueOnce(new Error('ntfy down'));

    const log = silentLog();
    await dispatchNotifications(
      {
        webhookUrl: 'https://example.com/hook',
        ntfyUrl: 'https://ntfy.sh/topic',
        on: ['change'],
      },
      baseEvent,
      { log },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });
});
