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

      const parsed = stateFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.provider !== provider) {
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
