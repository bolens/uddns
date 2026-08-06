/**
 * Shared validated JSON loading and corrupt-file quarantine.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';

import type { z } from 'zod';

import { hasErrorCode } from './errors.js';

async function quarantineCorruptFile(
  resolved: string,
  label: string,
  reason: string,
): Promise<void> {
  const corrupt = `${resolved}.corrupt.${process.pid}.${Date.now()}.${randomUUID()}`;
  try {
    await rename(resolved, corrupt);
    console.warn(`uDDNS: quarantined corrupt ${label} file (${reason}) -> ${corrupt}`);
  } catch {
    console.warn(`uDDNS: ignoring corrupt ${label} file (${reason}): ${resolved}`);
  }
}

export async function loadValidatedJsonFile<T>(
  resolved: string,
  label: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    await quarantineCorruptFile(resolved, label, 'invalid JSON');
    return null;
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    await quarantineCorruptFile(resolved, label, 'schema validation failed');
    return null;
  }
  return parsed.data;
}
