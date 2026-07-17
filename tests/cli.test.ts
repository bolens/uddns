import { describe, expect, it, vi } from 'vite-plus/test';

import { main } from '../cli.js';

describe('cli', () => {
  it('prints help', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await main(['help']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    info.mockRestore();
  });

  it('rejects unknown commands', async () => {
    await expect(main(['nope'])).rejects.toThrow(/Unknown command/);
  });
});
