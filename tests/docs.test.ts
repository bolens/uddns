import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vite-plus/test';

import { listProviderIds } from '../lib/providers/index.js';

const root = new URL('../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

describe('documentation contracts', () => {
  it('keeps the documented provider list in sync with the registry', async () => {
    const readme = await read('README.md');
    const providerLine = readme.match(/Set `DDNS_PROVIDER` to one of: ([^\n]+)/)?.[1] ?? '';
    const documented = [...providerLine.matchAll(/`([a-z0-9-]+)`/g)]
      .map((match) => match[1])
      .filter((provider): provider is string => provider !== undefined);

    expect(documented.sort((left, right) => left.localeCompare(right))).toEqual(
      [...listProviderIds()].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('keeps the environment template in sync with runtime configuration', async () => {
    const [config, envExample] = await Promise.all([
      read('lib/schemas/config.ts'),
      read('.env.example'),
    ]);

    const runtimeKeys = new Set(
      [
        ...config.matchAll(/\b(?:env|parsedEnv)\.([A-Z][A-Z0-9_]*)/g),
        ...config.matchAll(/parsedEnv\['([A-Z][A-Z0-9_]*)'\]/g),
      ]
        .map((match) => match[1])
        .filter((key): key is string => Boolean(key))
        .filter((key) => key !== 'DDNS_HOSTNAME'),
    );

    for (const key of runtimeKeys) {
      expect(
        envExample,
        `${key} is accepted by lib/schemas/config.ts but missing from .env.example`,
      ).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }
  });

  it('only documents package scripts that exist', async () => {
    const [readme, packageJson] = await Promise.all([read('README.md'), read('package.json')]);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
    const documentedScripts = [...readme.matchAll(/\bvp run ([\w:-]+)/g)].map((match) => match[1]);

    expect(documentedScripts.length).toBeGreaterThan(0);
    for (const script of documentedScripts) {
      expect(scripts, `README references missing package script "${script}"`).toHaveProperty(
        script!,
      );
    }
  });
});
