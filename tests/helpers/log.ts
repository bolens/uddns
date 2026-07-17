import { vi } from 'vite-plus/test';

import type { Logger } from '../../lib/log.js';

export function silentLog(): Logger {
  return {
    level: 'info',
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}
