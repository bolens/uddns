import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vite-plus/test';

import {
  DEFAULT_DYNDNS_UPDATE_URL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  DEFAULT_PROVIDER,
  DEFAULT_STATE_FILE,
} from '../lib/defaults.js';
import { MCP_RESOURCE_URIS } from '../lib/mcp/resources.js';
import { MCP_PROMPT_NAMES, MCP_TOOL_NAMES } from '../lib/mcp/server.js';
import { userAgent } from '../lib/providers/http.js';
import { listProviderIds } from '../lib/providers/index.js';

const root = new URL('../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function markdownFiles(): Promise<Array<{ path: string; content: string }>> {
  const docs = (await readdir(new URL('docs/', root)))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  const paths = ['README.md', ...docs];
  return await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await read(path),
    })),
  );
}

describe('documentation contracts', () => {
  it('keeps the documented provider list in sync with the registry', async () => {
    const providers = await read('docs/providers.md');
    const providerBlock =
      providers.match(/Set `UDDNS_PROVIDER` to one of:([\s\S]*?)\n\n/)?.[1] ?? '';
    const documented = [...providerBlock.matchAll(/`([a-z0-9-]+)`/g)]
      .map((match) => match[1])
      .filter((provider): provider is string => provider !== undefined);

    expect(documented.sort((left, right) => left.localeCompare(right))).toEqual(
      [...listProviderIds()].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('keeps the environment template in sync with runtime configuration', async () => {
    const [config, mcpConfig, healthConfig, envExample] = await Promise.all([
      read('lib/schemas/config.ts'),
      read('lib/mcp/config.ts'),
      read('lib/health-config.ts'),
      read('.env.example'),
    ]);

    const runtimeKeys = new Set(
      [
        ...config.matchAll(/\b(?:env|parsedEnv)\.([A-Z][A-Z0-9_]*)/g),
        ...config.matchAll(/parsedEnv\['([A-Z][A-Z0-9_]*)'\]/g),
        ...mcpConfig.matchAll(/env\['([A-Z][A-Z0-9_]*)'\]/g),
        ...healthConfig.matchAll(/env\['([A-Z][A-Z0-9_]*)'\]/g),
      ]
        .map((match) => match[1])
        .filter((key): key is string => Boolean(key))
        .filter((key) => key !== 'UDDNS_HOSTNAME'),
    );

    for (const key of runtimeKeys) {
      expect(
        envExample,
        `${key} is accepted by config loaders but missing from .env.example`,
      ).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
    }
  });

  it('keeps documented defaults synchronized', async () => {
    const [readme, providers, mcp, envExample] = await Promise.all([
      read('README.md'),
      read('docs/providers.md'),
      read('docs/mcp.md'),
      read('.env.example'),
    ]);

    expect(envExample).toMatch(new RegExp(`^UDDNS_PROVIDER=${DEFAULT_PROVIDER}$`, 'm'));
    expect(envExample).toMatch(new RegExp(`^UDDNS_INTERVAL=${DEFAULT_INTERVAL_MS}$`, 'm'));
    expect(envExample).toMatch(new RegExp(`^UDDNS_STATE_FILE=${DEFAULT_STATE_FILE}$`, 'm'));
    expect(envExample).toContain(`DYNDNS_UPDATE_URL=${DEFAULT_DYNDNS_UPDATE_URL}`);

    expect(readme).toContain(`\`${DEFAULT_INTERVAL_MS}\``);
    expect(providers).toContain(`UDDNS_INTERVAL=${DEFAULT_INTERVAL_MS}`);
    expect(providers).toContain(DEFAULT_STATE_FILE);
    expect(providers).toContain(DEFAULT_DYNDNS_UPDATE_URL);
    expect(mcp).toContain(`UDDNS_MCP_HOST=${DEFAULT_MCP_HOST}`);
    expect(mcp).toContain(`UDDNS_MCP_PORT=${DEFAULT_MCP_PORT}`);
  });

  it('documents every MCP tool, prompt, and resource', async () => {
    const mcp = await read('docs/mcp.md');

    for (const tool of MCP_TOOL_NAMES) {
      expect(mcp, `Missing MCP tool ${tool}`).toContain(`\`${tool}\``);
    }
    for (const prompt of MCP_PROMPT_NAMES) {
      expect(mcp, `Missing MCP prompt ${prompt}`).toContain(`\`${prompt}\``);
    }
    for (const uri of Object.values(MCP_RESOURCE_URIS)) {
      expect(mcp, `Missing MCP resource ${uri}`).toContain(`\`${uri}\``);
    }
  });

  it('keeps README guide links valid', async () => {
    const readme = await read('README.md');
    const links = [...readme.matchAll(/\]\((docs\/[^)]+\.md)\)/g)]
      .map((match) => match[1])
      .filter((path): path is string => Boolean(path));

    expect([...new Set(links)].sort()).toEqual(
      ['docs/deployment.md', 'docs/development.md', 'docs/mcp.md', 'docs/providers.md'].sort(),
    );
    await expect(Promise.all(links.map(read))).resolves.toHaveLength(links.length);
  });

  it('only documents package scripts that exist', async () => {
    const [files, packageJson] = await Promise.all([markdownFiles(), read('package.json')]);
    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

    for (const { path, content } of files) {
      for (const match of content.matchAll(/\bvp run ([\w:-]+)/g)) {
        const script = match[1];
        expect(scripts, `${path} references missing package script "${script}"`).toHaveProperty(
          script!,
        );
      }
    }
  });

  it('keeps the core app default and MCP optional in packaging', async () => {
    const [packageJsonRaw, dockerfile, buildConfig, fallow] = await Promise.all([
      read('package.json'),
      read('Dockerfile'),
      read('tsconfig.build.json'),
      read('.fallowrc.json'),
    ]);
    const packageJson = JSON.parse(packageJsonRaw) as {
      main: string;
      bin?: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(packageJson.main).toBe('dist/app.js');
    expect(packageJson.bin?.['uddns']).toBe('./dist/cli.js');
    expect(packageJson.scripts['start']).toContain('dist/app.js');
    expect(packageJson.scripts['config:check']).toContain('dist/app.js');
    expect(packageJson.scripts['mcp']).toContain('dist/mcp.js');
    expect(packageJson.scripts['mcp:http']).toContain('dist/mcp.js');
    expect(dockerfile).toContain('ENTRYPOINT ["node"]');
    expect(dockerfile).toContain('CMD ["dist/app.js"]');
    expect(buildConfig).toContain('"app.ts"');
    expect(buildConfig).toContain('"mcp.ts"');
    expect(buildConfig).toContain('"cli.ts"');
    expect(fallow).toContain('"app.ts"');
    expect(fallow).toContain('"mcp.ts"');
    expect(fallow).toContain('"cli.ts"');
  });

  it('keeps every non-live test represented in the CI matrix', async () => {
    const [ci, entries] = await Promise.all([
      read('.github/workflows/ci.yml'),
      readdir(new URL('tests/', root), { withFileTypes: true }),
    ]);
    const rootTests = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => `tests/${entry.name}`);

    expect(ci).toContain("- 'app.ts'");
    expect(ci).toContain("- 'mcp.ts'");
    expect(ci).toContain("- 'cli.ts'");
    expect(ci).toContain("- 'docs/**'");
    expect(ci).toContain("- 'examples/**'");
    expect(ci).toContain('paths: tests/providers');
    for (const testPath of rootTests) {
      expect(ci, `${testPath} is missing from the CI test matrix`).toContain(testPath);
    }
  });

  it('keeps the HTTP User-Agent in sync with package version', async () => {
    const { version } = JSON.parse(await read('package.json')) as { version: string };
    expect(userAgent).toBe(`uDDNS/${version}`);
  });
});
