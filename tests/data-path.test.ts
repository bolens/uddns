import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { resolveDataFilePath } from '../lib/data-path.js';

describe('resolveDataFilePath', () => {
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
