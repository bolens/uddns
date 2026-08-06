/**
 * Crash-resistant file replacement for small JSON state files.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  'EACCES',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EPERM',
]);

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error.code)
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Write, fsync, and atomically replace a file, then fsync its containing
 * directory when the host filesystem supports directory handles.
 */
export async function replaceFileDurably(
  file: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });

  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch {
        // Preserve the original write/rename failure. A stale unique temp file
        // is less harmful than masking the error callers need to handle.
      }
    }
  }
}
