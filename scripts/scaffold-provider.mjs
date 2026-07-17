#!/usr/bin/env node
/**
 * Scaffold a new provider stub + test file.
 *
 * Usage: node scripts/scaffold-provider.mjs <id> "Provider Label"
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const id = process.argv[2];
const label = process.argv[3] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');

if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error('Usage: node scripts/scaffold-provider.mjs <id> "Provider Label"');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const providerPath = path.join(root, 'lib/providers', `${id}.ts`);
const testPath = path.join(root, 'tests/providers', `${id}.test.ts`);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

if (await exists(providerPath)) {
  console.error(`Already exists: ${providerPath}`);
  process.exit(1);
}

const providerSource = `/**
 * ${label} Dynamic DNS provider.
 */

import { fail, ok } from '../result.js';
import type { Provider } from '../schemas/provider.js';
import { request } from './http.js';

export const ${id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider: Provider = {
  id: '${id}',
  label: '${label}',
  async update(config, ip) {
    void config;
    void ip;
    void request;
    return fail('${id} provider stub — implement update()');
    // return ok('updated');
  },
};
`;

const testSource = `import { describe, expect, it } from 'vite-plus/test';

import { ${id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider } from '../../lib/providers/${id}.js';
import { makeConfig } from '../helpers/config.js';

describe('${id} provider', () => {
  it('exports id and label', () => {
    expect(${id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider.id).toBe('${id}');
    expect(${id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider.label).toBe('${label}');
  });

  it('fails until implemented', async () => {
    const result = await ${id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Provider.update(
      makeConfig({ provider: 'cloudflare' }),
      { v4: '203.0.113.10', v6: null },
    );
    expect(result.ok).toBe(false);
  });
});
`;

await mkdir(path.dirname(providerPath), { recursive: true });
await mkdir(path.dirname(testPath), { recursive: true });
await writeFile(providerPath, providerSource);
await writeFile(testPath, testSource);

console.log(`Wrote ${providerPath}`);
console.log(`Wrote ${testPath}`);
console.log(`
Checklist:
  1. Add '${id}' to PROVIDER_IDS in lib/schemas/provider.ts
  2. Add config schema + AppConfig fields
  3. Register in lib/providers/index.ts
  4. Map env vars in lib/schemas/config.ts (+ MANAGED_ENV_PREFIXES)
  5. Add MCP setup hints in lib/mcp/prompts.ts
  6. Update docs/providers.md and .env.example
  7. Expand ${path.relative(root, testPath)}
`);
