/**
 * Durable per-host update state. The file contains public IPs only; credentials
 * and provider responses are never persisted.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { publicIpSchema, type ProviderId, type PublicIP } from './schemas/provider.js';

export type HostState = Record<string, PublicIP>;

export type StateStore = {
  load: () => Promise<HostState>;
  save: (state: HostState) => Promise<void>;
};

type StateFile = {
  version: 1;
  provider: ProviderId;
  hosts: HostState;
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

      const parsed: unknown = JSON.parse(raw);
      if (!isStateFile(parsed) || parsed.provider !== provider) {
        return {};
      }
      return parsed.hosts;
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

function isStateFile(value: unknown): value is StateFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { version?: unknown; provider?: unknown; hosts?: unknown };
  if (
    candidate.version !== 1 ||
    typeof candidate.provider !== 'string' ||
    !candidate.hosts ||
    typeof candidate.hosts !== 'object'
  ) {
    return false;
  }
  return Object.entries(candidate.hosts).every(
    ([host, ip]) => host.length > 0 && publicIpSchema.safeParse(ip).success,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
