/**
 * One-shot update cycle for `uddns once`.
 */

import { loadConfig } from './config.js';
import { createLogger, formatError, type Logger } from './log.js';
import { getProvider } from './providers/index.js';
import type { AppConfig, Provider } from './schemas/provider.js';
import { createUpdater, type Updater } from './updater.js';

export type OnceOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  force?: boolean;
  dryRun?: boolean;
  log?: Logger;
  loadConfigFn?: (env: NodeJS.ProcessEnv | Record<string, string | undefined>) => AppConfig;
  getProviderFn?: (id: string) => Provider;
  createUpdaterFn?: (options: { config: AppConfig; provider: Provider; log: Logger }) => Updater;
  exit?: (code: number) => void;
};

export async function runOnce(options: OnceOptions = {}): Promise<void> {
  const log = options.log ?? createLogger();
  const env = options.env ?? process.env;
  const loadConfigFn = options.loadConfigFn ?? loadConfig;
  const getProviderFn = options.getProviderFn ?? getProvider;
  const createUpdaterFn = options.createUpdaterFn ?? createUpdater;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  try {
    const config = loadConfigFn(env);
    const provider = getProviderFn(config.provider);
    const updater = createUpdaterFn({ config, provider, log });
    const result = await updater.checkOnce({
      ...(options.force ? { force: true } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    if (result.status === 'error') {
      log.error(result.message, result);
      exit(1);
      return;
    }
    if (result.status === 'partial') {
      log.warn(result.message, result);
      exit(1);
      return;
    }
    log.success(result.message, { status: result.status, ip: result.ip });
  } catch (error) {
    log.error('One-shot update failed', formatError(error));
    exit(1);
  }
}
