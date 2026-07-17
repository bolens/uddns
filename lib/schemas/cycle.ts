/**
 * Shared cycle-complete event emitted by the updater for history, notify, metrics.
 */

import type { CheckResult, HostUpdateResult, PublicIP } from './provider.js';

export type CycleEvent = {
  at: string;
  status: CheckResult['status'];
  ip: PublicIP;
  message: string;
  hostResults?: HostUpdateResult[];
  forced?: boolean;
  dryRun?: boolean;
  durationMs: number;
  accountId?: string;
  cycle: number;
};

export function cycleEventFromResult(
  result: CheckResult,
  meta: {
    cycle: number;
    durationMs: number;
    forced?: boolean;
    dryRun?: boolean;
    accountId?: string;
    at?: string;
  },
): CycleEvent {
  const event: CycleEvent = {
    at: meta.at ?? new Date().toISOString(),
    status: result.status,
    ip: result.ip,
    message: result.message,
    durationMs: meta.durationMs,
    cycle: meta.cycle,
  };
  if (result.hostResults) {
    event.hostResults = result.hostResults;
  }
  if (meta.forced !== undefined) {
    event.forced = meta.forced;
  }
  if (meta.dryRun !== undefined) {
    event.dryRun = meta.dryRun;
  }
  if (meta.accountId !== undefined) {
    event.accountId = meta.accountId;
  }
  return event;
}
