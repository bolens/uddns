import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vite-plus/test';

import { buildEnvContents, runInit } from '../lib/init.js';
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
  it('accepts the maximum runtime interval', () => {
    expect(
      buildEnvContents({ provider: 'duckdns', hosts: 'home', interval: '86400000' }),
    ).toContain('UDDNS_INTERVAL=86400000');
  });

  it('preserves existing content when forced input is rejected', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-init-'));
    const envPath = path.join(dir, '.env');
    await writeFile(envPath, 'UDDNS_PROVIDER=cloudflare\n');
    const answers = ['duckdns', 'home\nOTHER=value', '60000'];
    const exit = vi.fn();
    await runInit({
      force: true,
      envPath,
      log: silentLog(),
      ask: async () => answers.shift() ?? '',
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(await readFile(envPath, 'utf8')).toBe('UDDNS_PROVIDER=cloudflare\n');
  });

  it.each(['59999', '86400001', 'Infinity', 'NaN'])(
    'rejects an unusable template interval %s',
    (interval) => {
      expect(() => buildEnvContents({ provider: 'duckdns', hosts: 'home', interval })).toThrow(
        /60000.*86400000/,
      );
    },
  );

  it.each(['home\nUDDNS_HEALTH_ALLOW_INSECURE_LOOPBACK=true', 'home\rOTHER=value', 'home\0other'])(
    'rejects control characters in template hosts',
    (hosts) => {
      expect(() => buildEnvContents({ provider: 'duckdns', hosts, interval: '60000' })).toThrow(
        /single line/,
      );
    },
  );

  it('rejects an oversized prompted interval before writing a file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-init-'));
    const envPath = path.join(dir, '.env');
    const answers = ['duckdns', 'home', '86400001'];
    const exit = vi.fn();
    await runInit({ envPath, log: silentLog(), ask: async () => answers.shift() ?? '', exit });
    expect(exit).toHaveBeenCalledWith(1);
    await expect(readFile(envPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
