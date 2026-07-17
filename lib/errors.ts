/**
 * Narrow helpers for reading properties off unknown thrown values.
 */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getErrorProp<T = unknown>(error: unknown, key: string): T | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key] as T;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return getErrorProp(error, 'code') === code;
}

export type NetworkErrorFields = {
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  hostname?: string;
};

export function networkErrorFields(error: unknown): NetworkErrorFields {
  const fields: NetworkErrorFields = {};
  const code = getErrorProp<string | number>(error, 'code');
  const errno = getErrorProp<string | number>(error, 'errno');
  const syscall = getErrorProp<string>(error, 'syscall');
  const hostname = getErrorProp<string>(error, 'hostname');

  if (code !== undefined) {
    fields.code = code;
  }
  if (errno !== undefined) {
    fields.errno = errno;
  }
  if (typeof syscall === 'string') {
    fields.syscall = syscall;
  }
  if (typeof hostname === 'string') {
    fields.hostname = hostname;
  }
  return fields;
}
