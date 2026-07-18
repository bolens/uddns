import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

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
        message: 'one failed: Bearer leaked-on-disk',
        hostResults: [
          {
            host: 'ok.example.com',
            result: { ok: true, message: 'updated' },
          },
          {
            host: 'bad.example.com',
            result: {
              ok: false,
              message: 'denied Bearer leaked-on-disk',
              details: { authorization: 'Bearer secret-token' },
            },
          },
        ],
      }),
    );

    const events = await store.load();
    expect(events[0]?.message).toBe('one failed: Bearer [redacted]');
    expect(events[0]?.failedHosts).toEqual([
      { host: 'bad.example.com', message: 'denied Bearer [redacted]' },
    ]);
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(JSON.stringify(events)).not.toContain('leaked-on-disk');
  });

  it('skips pure unchanged unless forced', () => {
    expect(shouldRecordHistory(event({ status: 'unchanged' }))).toBe(false);
    expect(shouldRecordHistory(event({ status: 'unchanged', forced: true }))).toBe(true);
  });

  it('quarantines corrupt history JSON and returns an empty list', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'history.json');
    await writeFile(file, '{not-json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createFileHistoryStore(file);
    await expect(store.load()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/quarantined corrupt history/));
    warn.mockRestore();
  });

  it('quarantines history that fails schema validation', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'history.json');
    await writeFile(file, JSON.stringify({ version: 1, events: [{ bad: true }] }), 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createFileHistoryStore(file);
    await expect(store.load()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/schema validation failed/));
    warn.mockRestore();
  });

  it('rethrows unexpected history load errors', async () => {
    const { mkdir } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'not-a-file');
    await mkdir(file);
    const store = createFileHistoryStore(file);
    await expect(store.load()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('persists dryRun and forced flags when present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-history-'));
    const file = path.join(dir, 'history.json');
    const store = createFileHistoryStore(file);
    await store.append(event({ dryRun: true, forced: true, status: 'dry_run', accountId: 'acct' }));
    const events = await store.load();
    expect(events[0]).toMatchObject({
      dryRun: true,
      forced: true,
      status: 'dry_run',
      accountId: 'acct',
    });
  });
});
