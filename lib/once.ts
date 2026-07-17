/**
 * One-shot update cycle for `uddns once`.
 */

import { resolveAccounts } from './config-file.js';
import { createLogger, formatError, type Logger } from './log.js';
import { getProvider } from './providers/index.js';
import { createRuntimeBundle } from './runtime.js';
import type { AppConfig, Provider } from './schemas/provider.js';
import type { Updater, UpdaterOptions } from './updater.js';

export type OnceOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  force?: boolean;
  dryRun?: boolean;
  log?: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  resolveAccountsFn?: (
    env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ) => Array<{ id: string; config: AppConfig }> | Promise<Array<{ id: string; config: AppConfig }>>;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: UpdaterOptions) => Updater;
  exit?: (code: number) => void;
};

export async function runOnce(options: OnceOptions = {}): Promise<void> {
  const log = options.log ?? createLogger();
  const env = options.env ?? process.env;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  try {
    const resolveAccountsFn =
      options.resolveAccountsFn ??
      (options.loadConfigFn
        ? (resolveEnv: NodeJS.ProcessEnv | Record<string, string | undefined>) => [
            { id: 'default', config: options.loadConfigFn!(resolveEnv) },
          ]
        : resolveAccounts);
    const accounts = await Promise.resolve(resolveAccountsFn(env));
    if (accounts.length === 0) {
      throw new Error('No accounts configured');
    }

    let exitCode = 0;
    for (const account of accounts) {
      const bundle = createRuntimeBundle({
        config: account.config,
        log,
        accountId: account.id,
        getProviderFn,
        ...(options.createUpdaterFn ? { createUpdaterFn: options.createUpdaterFn } : {}),
      });
      const result = await bundle.updater.checkOnce({
        ...(options.force ? { force: true } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      const prefix = accounts.length > 1 ? `[${account.id}] ` : '';
      if (result.status === 'error' || result.status === 'skipped_no_ip') {
        log.error(`${prefix}${result.message}`, result);
        exitCode = 1;
        continue;
      }
      if (result.status === 'partial') {
        log.warn(`${prefix}${result.message}`, result);
        exitCode = 1;
        continue;
      }
      log.success(`${prefix}${result.message}`, { status: result.status, ip: result.ip });
    }
    exit(exitCode);
  } catch (error) {
    log.error('One-shot update failed', formatError(error));
    exit(1);
  }
}
