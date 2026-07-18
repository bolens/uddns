import { afterEach, vi } from 'vite-plus/test';

import { setRequestFetchOverride } from '../../lib/providers/http.js';

/** Unstub globals (fetch) and restore mocks after each test. */
export function afterEachResetFetch(): void {
  afterEach(() => {
    setRequestFetchOverride(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

/** Restore mocks after each test (no global unstub). */
export function afterEachRestoreMocks(): void {
  afterEach(() => {
    setRequestFetchOverride(null);
    vi.restoreAllMocks();
  });
}
