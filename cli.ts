#!/usr/bin/env node
/**
 * Unified uDDNS CLI entry (`uddns <command>`).
 */

import { pathToFileURL } from 'node:url';

import { main as appMain } from './app.js';
import { runInit } from './lib/init.js';
import { createLogger, formatError } from './lib/log.js';
import { main as mcpMain } from './mcp.js';

const COMMANDS = ['start', 'mcp', 'once', 'check-config', 'init', 'help'] as const;
type Command = (typeof COMMANDS)[number];

function printHelp(): void {
  console.info(`uDDNS — micro multi-provider Dynamic DNS updater

Usage:
  uddns start [--check-config]
  uddns once [--force] [--dry-run]
  uddns mcp [--transport=stdio|http]
  uddns check-config
  uddns init [--defaults] [--force]
  uddns help
`);
}

function parseCommand(argv: string[]): { command: Command; rest: string[] } {
  const [head, ...rest] = argv;
  if (!head || head === '-h' || head === '--help') {
    return { command: 'help', rest: [] };
  }
  if ((COMMANDS as readonly string[]).includes(head)) {
    return { command: head as Command, rest };
  }
  // Backward-compatible: flags without a subcommand act as `start`.
  if (head.startsWith('-')) {
    return { command: 'start', rest: argv };
  }
  throw new Error(`Unknown command "${head}". Run \`uddns help\` for usage.`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, rest } = parseCommand(argv);

  switch (command) {
    case 'help':
      printHelp();
      return;
    case 'check-config':
      await appMain({ argv: ['--check-config', ...rest] });
      return;
    case 'start':
      await appMain({ argv: rest });
      return;
    case 'mcp':
      await mcpMain({ argv: rest });
      return;
    case 'once': {
      const { runOnce } = await import('./lib/once.js');
      await runOnce({
        argv: rest,
        force: rest.includes('--force'),
        dryRun: rest.includes('--dry-run'),
      });
      return;
    }
    case 'init':
      await runInit({
        defaults: rest.includes('--defaults'),
        force: rest.includes('--force'),
        argv: rest,
      });
      return;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await main();
  } catch (error) {
    const log = createLogger();
    log.error('CLI failed', formatError(error));
    process.exit(1);
  }
}
