import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vite-plus/test';

describe('scaffold-provider', () => {
  it('writes provider and test stubs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'uddns-scaffold-'));
    const script = path.resolve('scripts/scaffold-provider.mjs');
    // Run against a temp copy of expected relative layout by chdir... script uses import.meta.dirname
    // so write into the real tree with a unique id then clean up is heavy; instead assert script help.
    const help = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(help.status).not.toBe(0);
    expect(help.stderr).toContain('Usage:');

    const id = `tmp${Date.now().toString(36)}`;
    const result = spawnSync(process.execPath, [script, id, 'Temp Provider'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(result.status).toBe(0);
    const provider = await readFile(`lib/providers/${id}.ts`, 'utf8');
    expect(provider).toContain(`id: '${id}'`);
    // cleanup generated stubs so fallow/docs stay clean
    const { unlink } = await import('node:fs/promises');
    await unlink(`lib/providers/${id}.ts`);
    await unlink(`tests/providers/${id}.test.ts`);
    void dir;
  });
});
