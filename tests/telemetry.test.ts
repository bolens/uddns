import * as api from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createTelemetry } from '../lib/telemetry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telemetry', () => {
  it('runs operations without wrapping when disabled', async () => {
    const telemetry = createTelemetry(false);
    await expect(telemetry.trace('noop', {}, async () => 42)).resolves.toBe(42);
  });

  it('records ok and error spans when enabled', async () => {
    const end = vi.fn();
    const setStatus = vi.fn();
    const recordException = vi.fn();
    const startActiveSpan = vi.fn(
      async (
        _name: string,
        _options: unknown,
        callback: (span: {
          setStatus: typeof setStatus;
          recordException: typeof recordException;
          end: typeof end;
        }) => Promise<unknown>,
      ) => callback({ setStatus, recordException, end }),
    );
    vi.spyOn(api.trace, 'getTracer').mockReturnValue({ startActiveSpan } as never);

    const telemetry = createTelemetry(true);
    await expect(telemetry.trace('ok-span', { host: 'a' }, async () => 'done')).resolves.toBe(
      'done',
    );
    expect(setStatus).toHaveBeenCalledWith({ code: api.SpanStatusCode.OK });
    expect(end).toHaveBeenCalled();

    await expect(
      telemetry.trace('err-span', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(setStatus).toHaveBeenCalledWith({
      code: api.SpanStatusCode.ERROR,
      message: 'boom',
    });

    await expect(
      telemetry.trace('non-error', {}, async () => {
        throw 'raw-failure';
      }),
    ).rejects.toBe('raw-failure');
    expect(recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(setStatus).toHaveBeenCalledWith({
      code: api.SpanStatusCode.ERROR,
      message: 'raw-failure',
    });
  });
});
