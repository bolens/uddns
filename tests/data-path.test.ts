import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { resolveDataFilePath } from '../lib/data-path.js';
import { loadConfig } from '../lib/config.js';

describe('resolveDataFilePath', () => {
  it('accepts the image default data paths for a standalone container', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const imageEnv = Object.fromEntries(
      [...dockerfile.matchAll(/^ENV (UDDNS_\w+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
    );
    const config = loadConfig({
      ...imageEnv,
      UDDNS_PROVIDER: 'duckdns',
      UDDNS_HOSTS: 'fleet-audit.invalid',
      DUCKDNS_TOKEN: 'synthetic-fixture-not-a-credential',
      UDDNS_HEALTH: '0',
    });
    expect(config.stateFile).toBe('/data/state.json');
    expect(config.historyFile).toBe('/data/history.json');
  });

  it('resolves relative paths under the data directory', () => {
    const root = path.resolve('/tmp/uddns-data');
    expect(resolveDataFilePath('state.json', 'UDDNS_STATE_FILE', root)).toBe(
      path.join(root, 'state.json'),
    );
  });

  it('allows absolute paths that stay under the data directory', () => {
    const root = path.resolve('/tmp/uddns-data');
    expect(
      resolveDataFilePath(path.join(root, 'nested', 'state.json'), 'UDDNS_STATE_FILE', root),
    ).toBe(path.join(root, 'nested', 'state.json'));
  });

  it('rejects escapes and absolute paths outside the data directory', () => {
    const root = path.resolve('/tmp/uddns-data');
    expect(() => resolveDataFilePath('../outside.json', 'UDDNS_STATE_FILE', root)).toThrow(
      /must resolve under data directory/,
    );
    expect(() => resolveDataFilePath('/etc/passwd', 'UDDNS_STATE_FILE', root)).toThrow(
      /must resolve under data directory/,
    );
  });
});
