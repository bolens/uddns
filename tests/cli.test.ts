import { describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  appMain: vi.fn(),
  mcpMain: vi.fn(),
  runInit: vi.fn(),
  runOnce: vi.fn(),
}));

vi.mock('../app.js', () => ({ main: mocks.appMain }));
vi.mock('../mcp.js', () => ({ main: mocks.mcpMain }));
vi.mock('../lib/init.js', () => ({ runInit: mocks.runInit }));
vi.mock('../lib/once.js', () => ({ runOnce: mocks.runOnce }));

import { main } from '../cli.js';

const helpCases: Array<[string[]]> = [[[]], [['help']], [['-h']], [['--help']]];

describe('cli', () => {
  it.each(helpCases)('prints help for %j', async (argv) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await main(argv);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    info.mockRestore();
  });

  it('rejects unknown commands', async () => {
    await expect(main(['nope'])).rejects.toThrow(/Unknown command/);
  });

  it('dispatches start and preserves backward-compatible start flags', async () => {
    await main(['start', '--check-config']);
    await main(['--check-config']);
    expect(mocks.appMain).toHaveBeenNthCalledWith(1, { argv: ['--check-config'] });
    expect(mocks.appMain).toHaveBeenNthCalledWith(2, { argv: ['--check-config'] });
  });

  it('dispatches check-config and MCP arguments', async () => {
    await main(['check-config', '--extra']);
    await main(['mcp', '--transport=http']);
    expect(mocks.appMain).toHaveBeenCalledWith({ argv: ['--check-config', '--extra'] });
    expect(mocks.mcpMain).toHaveBeenCalledWith({ argv: ['--transport=http'] });
  });

  it('dispatches once flags', async () => {
    await main(['once', '--force', '--dry-run']);
    expect(mocks.runOnce).toHaveBeenCalledWith({
      argv: ['--force', '--dry-run'],
      force: true,
      dryRun: true,
    });
  });

  it('dispatches init flags', async () => {
    await main(['init', '--defaults', '--force']);
    expect(mocks.runInit).toHaveBeenCalledWith({
      argv: ['--defaults', '--force'],
      defaults: true,
      force: true,
    });
  });
});
