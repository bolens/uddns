import { vi, type Mock } from 'vite-plus/test';

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function captureInterval(): {
  timers: Array<{ fn: () => void; delay: number }>;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  clear: Mock<(...args: unknown[]) => void>;
} {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const clear = vi.fn();
  return {
    timers,
    setIntervalFn: ((fn: () => void, delay?: number) => {
      timers.push({ fn, delay: delay ?? 0 });
      return timers.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: clear as typeof clearInterval,
    clear,
  };
}
