import { describe, expect, it } from 'vite-plus/test';

import { createMetricsTracker, startSideServer } from '../lib/side-server.js';

describe('side server', () => {
  it('serves health, metrics, and SSE', async () => {
    const metrics = createMetricsTracker();
    metrics.record({
      at: new Date().toISOString(),
      status: 'updated',
      ip: { v4: '203.0.113.10', v6: null },
      message: 'ok',
      durationMs: 1,
      cycle: 1,
    });

    const listeners: Array<(event: import('../lib/schemas/cycle.js').CycleEvent) => void> = [];
    const server = await startSideServer({
      config: { host: '127.0.0.1', port: 0, metricsEnabled: true },
      getStatus: () => ({
        running: true,
        stopping: false,
        intervalMs: 1000,
        currentIP: { v4: '203.0.113.10', v6: null },
        cycle: 1,
        inFlight: false,
        hosts: {},
        lastCycle: null,
        lastSuccessAt: null,
        lastError: null,
        nextRetryAt: null,
        accountId: null,
      }),
      getMetrics: () => metrics.snapshot(),
      onEventSubscribe: (listener) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
    });

    try {
      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const metricsRes = await fetch(`${server.url}/metrics`);
      expect(await metricsRes.text()).toContain('uddns_updates_total 1');

      const eventsRes = await fetch(`${server.url}/events`);
      expect(eventsRes.headers.get('content-type')).toContain('text/event-stream');
      for (const listener of listeners) {
        listener({
          at: new Date().toISOString(),
          status: 'updated',
          ip: { v4: '203.0.113.10', v6: null },
          message: 'ok',
          durationMs: 1,
          cycle: 2,
        });
      }
      const missing = await fetch(`${server.url}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('returns 404 for metrics when disabled', async () => {
    const server = await startSideServer({
      config: { host: '127.0.0.1', port: 0, metricsEnabled: false },
      getStatus: () => ({
        running: false,
        stopping: false,
        intervalMs: 1000,
        currentIP: { v4: null, v6: null },
        cycle: 0,
        inFlight: false,
        hosts: {},
        lastCycle: null,
        lastSuccessAt: null,
        lastError: null,
        nextRetryAt: null,
        accountId: null,
      }),
    });
    try {
      const metricsRes = await fetch(`${server.url}/metrics`);
      expect(metricsRes.status).toBe(404);
      const ready = await fetch(`${server.url}/readyz`);
      expect(ready.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
