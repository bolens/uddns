/**
 * Confine state/history paths under a data directory.
 */

import path from 'node:path';

/**
 * Resolve `file` under `dataDir` and reject paths that escape the root
 * (including absolute paths outside the data directory).
 */
export function resolveDataFilePath(file: string, label: string, dataDir: string): string {
  const root = path.resolve(dataDir);
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `${label} must resolve under data directory "${root}" (set UDDNS_DATA_DIR to allow another root)`,
    );
  }
  return resolved;
}
