import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createFileStateStore } from '../lib/state.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'uddns-state-'));
  directories.push(directory);
  return path.join(directory, 'nested', 'state.json');
}

describe('file state store', () => {
  it('returns empty state for a missing file and round-trips valid checkpoints', async () => {
    const file = await statePath();
    const store = createFileStateStore(file, 'cloudflare');
    expect(await store.load()).toEqual({});

    const state = {
      'home.example.com': { v4: '203.0.113.10', v6: '2001:db8::10' },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it('ignores state belonging to another provider or containing invalid IPs', async () => {
    const file = await statePath();
    const store = createFileStateStore(file, 'cloudflare');

    const writer = createFileStateStore(file, 'duckdns');
    await writer.save({ home: { v4: '203.0.113.10', v6: null } });
    expect(await store.load()).toEqual({});

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        provider: 'cloudflare',
        hosts: { home: { v4: 'not-an-ip', v6: null } },
      }),
    );
    expect(await store.load()).toEqual({});
  });

  it('ignores structurally malformed state files', async () => {
    const file = await statePath();
    const store = createFileStateStore(file, 'cloudflare');
    await store.save({});
    const validHosts = { home: { v4: '203.0.113.10', v6: null } };

    const malformed: unknown[] = [
      'just a string',
      42,
      { version: 2, provider: 'cloudflare', hosts: validHosts },
      { version: 1, provider: 42, hosts: validHosts },
      { version: 1, provider: 'cloudflare', hosts: null },
      { version: 1, provider: 'cloudflare', hosts: 'nope' },
      { version: 1, provider: 'cloudflare', hosts: { '': { v4: '203.0.113.10', v6: null } } },
      { version: 1, provider: 'cloudflare', hosts: { home: { v4: null, v6: 'not-an-ip' } } },
      { version: 1, provider: 'cloudflare', hosts: { home: { v4: 123, v6: null } } },
      { version: 1, provider: 'cloudflare', hosts: { home: null } },
    ];

    for (const contents of malformed) {
      await writeFile(file, JSON.stringify(contents));
      expect(await store.load(), JSON.stringify(contents)).toEqual({});
    }
  });

  it('rethrows read failures other than a missing file', async () => {
    const file = await statePath();
    // Create a directory at the state path so readFile fails with EISDIR.
    const store = createFileStateStore(path.dirname(file), 'cloudflare');
    await createFileStateStore(file, 'cloudflare').save({});

    await expect(store.load()).rejects.toThrow(/EISDIR|directory/i);
  });

  it('propagates invalid JSON as an error', async () => {
    const file = await statePath();
    const store = createFileStateStore(file, 'cloudflare');
    await createFileStateStore(file, 'cloudflare').save({});
    await writeFile(file, '{not json');

    await expect(store.load()).rejects.toThrow();
  });
});
