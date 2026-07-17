import type { JsonObject, JsonValue } from './schemas/json.js';
import { isSensitiveKey } from './sensitive.js';

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
} as const;

const SYMBOLS = {
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
  success: '✔',
} as const;

export type LogLevel = keyof typeof LEVELS;

export type ErrorInfo = JsonObject & {
  message: string;
  name?: string;
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  hostname?: string;
  stack?: string;
  cause?: ErrorInfo;
};

export type Logger = {
  error: (message: string, detail?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
  info: (message: string, context?: unknown) => void;
  success: (message: string, context?: unknown) => void;
  debug: (message: string, context?: unknown) => void;
  level: LogLevel;
};

export type LoggerOptions = {
  level?: string;
  now?: () => Date;
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const now = options.now ?? (() => new Date());
  const levelName = normalizeLevel(options.level ?? process.env['UDDNS_LOG_LEVEL'] ?? 'info');
  const threshold = LEVELS[levelName];

  const writeInfo = options.info ?? ((...args: unknown[]) => console.info(...args));
  const writeWarn = options.warn ?? ((...args: unknown[]) => console.warn(...args));
  const writeError = options.error ?? ((...args: unknown[]) => console.error(...args));
  const writeDebug = options.debug ?? writeInfo;

  function write(
    level: LogLevel,
    symbol: string,
    message: string,
    writer: (...args: unknown[]) => void,
    context?: unknown,
  ): void {
    if (LEVELS[level] > threshold) {
      return;
    }

    const line = `${symbol} ${formatTimestamp(now())} | ${message}`;
    if (context === undefined) {
      writer(line);
      return;
    }

    writer(line);
    writer(formatContext(context));
  }

  return {
    level: levelName,
    error(message, detail) {
      write('error', SYMBOLS.error, message, writeError, detail);
    },
    warn(message, context) {
      write('warn', SYMBOLS.warning, message, writeWarn, context);
    },
    info(message, context) {
      write('info', SYMBOLS.info, message, writeInfo, context);
    },
    success(message, context) {
      write('info', SYMBOLS.success, message, writeInfo, context);
    },
    debug(message, context) {
      write('debug', '·', message, writeDebug, context);
    },
  };
}

export function formatTimestamp(date: Date): string {
  const parts = Object.fromEntries(
    TIMESTAMP_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']}`;
}

export function normalizeLevel(value: string | undefined): LogLevel {
  const level = (value ?? 'info').toLowerCase();
  if (level === 'error' || level === 'warn' || level === 'info' || level === 'debug') {
    return level;
  }
  return 'info';
}

export function formatError(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    const out: ErrorInfo = {
      message: error.message,
      name: error.name,
    };

    if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) {
      out['code'] = error.code;
    }
    if ('errno' in error && (typeof error.errno === 'string' || typeof error.errno === 'number')) {
      out['errno'] = error.errno;
    }
    if ('syscall' in error && typeof error.syscall === 'string') {
      out['syscall'] = error.syscall;
    }
    if ('hostname' in error && typeof error.hostname === 'string') {
      out['hostname'] = error.hostname;
    }
    if (error.stack) {
      out['stack'] = error.stack;
    }
    if (error.cause !== undefined) {
      out['cause'] = formatError(error.cause);
    }
    // Error messages and stacks are often built from response bodies or URLs,
    // so scrub them like any other log context.
    return redact(out) as ErrorInfo;
  }

  if (typeof error === 'object' && error !== null) {
    return {
      message: 'Non-Error object',
      value: toJsonValue(redact(error)),
    };
  }

  return { message: String(error) };
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol') {
    return value.description ?? 'Symbol';
  }

  if (typeof value === 'function') {
    return value.name ? `[Function ${value.name}]` : '[Function]';
  }

  return 'undefined';
}

function formatContext(context: unknown): string {
  if (context instanceof Error) {
    return indentBlock(JSON.stringify(formatError(context), null, 2));
  }

  try {
    return indentBlock(JSON.stringify(redact(context), null, 2));
  } catch {
    return indentBlock(String(context));
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '[redacted]' : redact(entry);
    }
    return out;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  return value;
}

function redactString(value: string): string {
  if (looksLikeSecret(value)) {
    return '[redacted]';
  }
  // Also scrub credentials embedded mid-string (e.g. echoed request headers).
  return value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, '$1 [redacted]');
}

function looksLikeSecret(value: string): boolean {
  return /^(Bearer\s+)\S+/i.test(value) || /^Basic\s+\S+/i.test(value);
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
