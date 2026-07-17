import { vi, type Mock } from 'vite-plus/test';

import type { Provider, PublicIP } from '../../lib/schemas/provider.js';
import type { UpdaterStatus } from '../../lib/updater.js';

export function mockProvider(
  update: Provider['update'] = async () => ({ ok: true, message: 'ok' }),
  opts: Partial<Pick<Provider, 'id' | 'label'>> = {},
): Provider {
  return {
    id: opts.id ?? 'cloudflare',
    label: opts.label ?? 'Mock',
    update,
  };
}

const emptyStatus = (): UpdaterStatus => ({
  running: false,
  stopping: false,
  intervalMs: 900_000,
  currentIP: { v4: null, v6: null },
  cycle: 0,
  inFlight: false,
  hosts: {},
});

export type StubUpdater = {
  start: Mock<() => Promise<{ stop: () => Promise<void> }>>;
  stop: Mock<() => Promise<void>>;
  checkOnce: Mock<
    () => Promise<{
      status: 'unchanged';
      ip: PublicIP;
      message: string;
    }>
  >;
  checkOnceGuarded: Mock<
    () => Promise<{
      status: 'unchanged';
      ip: PublicIP;
      message: string;
    } | null>
  >;
  setIntervalMs: Mock<(ms: number) => void>;
  getStatus: Mock<() => UpdaterStatus>;
  getCurrentIP: () => PublicIP;
};

export function stubUpdater(stop: () => Promise<void> = async () => {}): StubUpdater {
  let status = emptyStatus();
  return {
    start: vi.fn(async () => {
      status = { ...status, running: true, stopping: false };
      return { stop };
    }),
    stop: vi.fn(async () => {
      status = { ...status, running: false, stopping: true };
      await stop();
    }),
    checkOnce: vi.fn(async () => ({
      status: 'unchanged' as const,
      ip: { v4: null, v6: null },
      message: 'unchanged',
    })),
    checkOnceGuarded: vi.fn(async () => ({
      status: 'unchanged' as const,
      ip: { v4: null, v6: null },
      message: 'unchanged',
    })),
    setIntervalMs: vi.fn((ms: number) => {
      status = { ...status, intervalMs: ms };
    }),
    getStatus: vi.fn(() => ({ ...status, currentIP: { ...status.currentIP } })),
    getCurrentIP: () => ({ v4: null, v6: null }),
  };
}
