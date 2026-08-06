/**
 * Durable per-host update state. The file contains public IPs only; credentials
 * and provider responses are never persisted.
 */

import path from 'node:path';

import { replaceFileDurably } from './atomic-file.js';
import { loadValidatedJsonFile } from './json-file.js';
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
      const parsed = await loadValidatedJsonFile(resolved, 'state', stateFileSchema);
      if (!parsed) {
        return {};
      }
      if (parsed.provider !== provider) {
        // Provider switches intentionally discard checkpoints; keep the file.
        console.warn(
          `uDDNS: ignoring state file for provider "${parsed.provider}" (current: "${provider}")`,
        );
        return {};
      }
      return parsed.hosts;
    },

    async save(hosts) {
      const state: StateFile = { version: 1, provider, hosts };
      await replaceFileDurably(resolved, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}
