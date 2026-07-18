/**
 * Durable per-host update state. The file contains public IPs only; credentials
 * and provider responses are never persisted.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hasErrorCode } from './errors.js';
import type { ProviderId, PublicIP } from './schemas/provider.js';
import { stateFileSchema, type StateFile } from './schemas/state.js';

export type HostState = Record<string, PublicIP>;

export type StateStore = {
  load: () => Promise<HostState>;
  save: (state: HostState) => Promise<void>;
};

async function quarantineCorruptFile(resolved: string, reason: string): Promise<void> {
  const corrupt = `${resolved}.corrupt.${process.pid}.${Date.now()}`;
  try {
    await rename(resolved, corrupt);
    console.warn(`uDDNS: quarantined corrupt state file (${reason}) -> ${corrupt}`);
  } catch {
    console.warn(`uDDNS: ignoring corrupt state file (${reason}): ${resolved}`);
  }
}

export function createFileStateStore(file: string, provider: ProviderId): StateStore {
  const resolved = path.resolve(file);

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(resolved, 'utf8');
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          return {};
        }
        throw error;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        await quarantineCorruptFile(resolved, 'invalid JSON');
        return {};
      }

      const parsed = stateFileSchema.safeParse(parsedJson);
      if (!parsed.success) {
        await quarantineCorruptFile(resolved, 'schema validation failed');
        return {};
      }
      if (parsed.data.provider !== provider) {
        // Provider switches intentionally discard checkpoints; keep the file.
        console.warn(
          `uDDNS: ignoring state file for provider "${parsed.data.provider}" (current: "${provider}")`,
        );
        return {};
      }
      return parsed.data.hosts;
    },

    async save(hosts) {
      const state: StateFile = { version: 1, provider, hosts };
      const directory = path.dirname(resolved);
      const temporary = `${resolved}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, resolved);
    },
  };
}
