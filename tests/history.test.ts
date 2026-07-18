import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { createFileHistoryStore, shouldRecordHistory } from '../lib/history.js';
import type { CycleEvent } from '../lib/schemas/cycle.js';

function event(overrides: Partial<CycleEvent> = {}): CycleEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    status: 'updated',
    ip: { v4: '203.0.113.10', v6: null },
    message: 'ok',
    durationMs: 12,
    cycle: 1,
    ...overrides,
  };
}

describe('history store', () => {
  it('records and rotates events', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'history.json');
    const store = createFileHistoryStore(file, { maxEvents: 2 });

    await store.append(event({ cycle: 1 }));
    await store.append(event({ cycle: 2, status: 'unchanged' }));
    await store.append(
      event({
        cycle: 3,
        status: 'error',
        message: 'fail',
        discoveryErrors: { v4: true, v6: true },
      }),
    );

    const events = await store.load();
    expect(events).toHaveLength(2);
    expect(events.map((entry) => entry.cycle)).toEqual([1, 3]);
    expect(events[1]?.discoveryErrors).toEqual({ v4: true, v6: true });
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('persists compact failedHosts without host result details', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'history.json');
    const store = createFileHistoryStore(file);

    await store.append(
      event({
        status: 'partial',
        message: 'one failed',
        hostResults: [
          {
            host: 'ok.example.com',
            result: { ok: true, message: 'updated' },
          },
          {
            host: 'bad.example.com',
            result: {
              ok: false,
              message: 'denied',
              details: { authorization: 'Bearer secret-token' },
            },
          },
        ],
      }),
    );

    const events = await store.load();
    expect(events[0]?.failedHosts).toEqual([{ host: 'bad.example.com', message: 'denied' }]);
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('skips pure unchanged unless forced', () => {
    expect(shouldRecordHistory(event({ status: 'unchanged' }))).toBe(false);
    expect(shouldRecordHistory(event({ status: 'unchanged', forced: true }))).toBe(true);
  });
});
