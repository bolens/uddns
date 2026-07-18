/**
 * Bounded ring-buffer of cycle events (separate from IP checkpoints).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_HISTORY_MAX } from './defaults.js';
import { hasErrorCode } from './errors.js';
import { redactString } from './log.js';
import type { CycleEvent } from './schemas/cycle.js';
import {
  HISTORY_VERSION,
  historyFileSchema,
  type HistoryEvent,
  type HistoryFile,
} from './schemas/history.js';

export type HistoryStore = {
  load: () => Promise<HistoryEvent[]>;
  append: (event: CycleEvent) => Promise<HistoryEvent[]>;
};

const RECORDABLE = new Set(['updated', 'partial', 'error', 'dry_run', 'skipped_no_ip']);

export function shouldRecordHistory(event: CycleEvent): boolean {
  if (event.forced) {
    return true;
  }
  return RECORDABLE.has(event.status);
}

export function createFileHistoryStore(
  file: string,
  options: { maxEvents?: number } = {},
): HistoryStore {
  const resolved = path.resolve(file);
  const maxEvents = options.maxEvents ?? DEFAULT_HISTORY_MAX;

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(resolved, 'utf8');
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          return [];
        }
        throw error;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return [];
      }

      const parsed = historyFileSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return [];
      }
      return parsed.data.events;
    },

    async append(event) {
      if (!shouldRecordHistory(event)) {
        return await this.load();
      }
      const failedHosts = event.hostResults
        ?.filter(({ result }) => !result.ok)
        .map(({ host, result }) => ({ host, message: redactString(result.message) }));
      const entry: HistoryEvent = {
        at: event.at,
        status: event.status,
        ip: event.ip,
        message: redactString(event.message),
        durationMs: event.durationMs,
        cycle: event.cycle,
        ...(event.discoveryErrors !== undefined ? { discoveryErrors: event.discoveryErrors } : {}),
        ...(event.forced !== undefined ? { forced: event.forced } : {}),
        ...(event.dryRun !== undefined ? { dryRun: event.dryRun } : {}),
        ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
        ...(failedHosts && failedHosts.length > 0 ? { failedHosts } : {}),
      };
      const existing = await this.load();
      const events = [...existing, entry].slice(-maxEvents);
      const state: HistoryFile = { version: HISTORY_VERSION, events };
      const directory = path.dirname(resolved);
      const temporary = `${resolved}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, resolved);
      return events;
    },
  };
}
