import { vi, type Mock } from 'vite-plus/test';

import type { Provider, PublicIP } from '../../lib/schemas/provider.js';

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
  getCurrentIP: () => PublicIP;
};

export function stubUpdater(stop: () => Promise<void> = async () => {}): StubUpdater {
  return {
    start: vi.fn(async () => ({ stop })),
    stop: vi.fn(stop),
    checkOnce: vi.fn(async () => ({
      status: 'unchanged' as const,
      ip: { v4: null, v6: null },
      message: 'unchanged',
    })),
    getCurrentIP: () => ({ v4: null, v6: null }),
  };
}
