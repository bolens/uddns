import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vite-plus/test';

import { runInit } from '../lib/init.js';
import { silentLog } from './helpers/log.js';

describe('init', () => {
  it('writes .env with defaults', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-init-'));
    const envPath = path.join(dir, '.env');
    await runInit({
      defaults: true,
      envPath,
      log: silentLog(),
      exit: vi.fn(),
    });
    const contents = await readFile(envPath, 'utf8');
    expect(contents).toContain('UDDNS_PROVIDER=cloudflare');
    expect(contents).toContain('UDDNS_HOSTS=');
  });

  it('refuses to overwrite without --force', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-init-'));
    const envPath = path.join(dir, '.env');
    await runInit({ defaults: true, envPath, log: silentLog(), exit: vi.fn() });
    const exit = vi.fn();
    await runInit({
      defaults: true,
      envPath,
      log: silentLog(),
      exit,
      stdin: Readable.from([]),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('prompts for values via ask helper', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-init-'));
    const envPath = path.join(dir, '.env');
    const answers = ['duckdns', 'myhost', '60000'];
    let index = 0;
    await runInit({
      envPath,
      log: silentLog(),
      ask: async () => answers[index++] ?? '',
      exit: vi.fn(),
    });
    const contents = await readFile(envPath, 'utf8');
    expect(contents).toContain('UDDNS_PROVIDER=duckdns');
    expect(contents).toContain('UDDNS_HOSTS=myhost');
    expect(contents).toContain('UDDNS_INTERVAL=60000');
  });
});
