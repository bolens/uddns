import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('node:fs/promises', () => mocks);

import { replaceFileDurably } from '../lib/atomic-file.js';

function fileHandle() {
  return {
    writeFile: vi.fn(),
    sync: vi.fn(),
    close: vi.fn(),
  };
}

describe('durable file replacement', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  it('syncs the file and containing directory around an atomic rename', async () => {
    const temporary = fileHandle();
    const directory = fileHandle();
    mocks.open.mockResolvedValueOnce(temporary).mockResolvedValueOnce(directory);

    await replaceFileDurably('/data/state.json', '{}\n');

    expect(mocks.mkdir).toHaveBeenCalledWith('/data', { recursive: true });
    expect(mocks.open).toHaveBeenNthCalledWith(
      1,
      `/data/state.json.${process.pid}.uuid.tmp`,
      'wx',
      0o600,
    );
    expect(temporary.writeFile).toHaveBeenCalledWith('{}\n', 'utf8');
    expect(temporary.sync).toHaveBeenCalled();
    expect(mocks.rename).toHaveBeenCalledWith(
      `/data/state.json.${process.pid}.uuid.tmp`,
      '/data/state.json',
    );
    expect(directory.sync).toHaveBeenCalled();
    expect(directory.close).toHaveBeenCalled();
  });

  it('tolerates filesystems that cannot sync directory handles', async () => {
    mocks.open
      .mockResolvedValueOnce(fileHandle())
      .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'EINVAL' }));

    await expect(replaceFileDurably('/data/history.json', '[]')).resolves.toBeUndefined();
  });

  it('propagates unexpected directory sync errors', async () => {
    mocks.open.mockResolvedValueOnce(fileHandle()).mockRejectedValueOnce(new Error('disk failure'));

    await expect(replaceFileDurably('/data/state.json', '{}')).rejects.toThrow('disk failure');
  });

  it('preserves write failures even when temporary cleanup also fails', async () => {
    const temporary = fileHandle();
    temporary.writeFile.mockRejectedValueOnce(new Error('write failure'));
    mocks.open.mockResolvedValueOnce(temporary);
    mocks.unlink.mockRejectedValueOnce(new Error('cleanup failure'));

    await expect(replaceFileDurably('/data/state.json', '{}')).rejects.toThrow('write failure');
    expect(temporary.close).toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(`/data/state.json.${process.pid}.uuid.tmp`);
  });
});
