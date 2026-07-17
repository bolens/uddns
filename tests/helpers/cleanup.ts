import { afterEach, vi } from 'vite-plus/test';

/** Unstub globals (fetch) and restore mocks after each test. */
export function afterEachResetFetch(): void {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}

/** Restore mocks after each test (no global unstub). */
export function afterEachRestoreMocks(): void {
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
