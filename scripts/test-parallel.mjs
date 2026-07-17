#!/usr/bin/env node
/**
 * Run the Vitest suite as parallel shards (multiple Vite servers), then merge
 * blob reports and coverage — same shape as CI.
 *
 * Env:
 *   TEST_SHARD_TOTAL  number of shards (default: min(4, cpu count))
 *   VITEST_MAX_WORKERS  optional workers per shard (passed through to Vitest)
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shardTotal = Math.max(1, Number(process.env.TEST_SHARD_TOTAL) || Math.min(4, cpus().length));

function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['run', 'test', '--', ...args], {
      cwd: root,
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `killed by ${signal}` : `exit ${code ?? 1}`));
    });
  });
}

await rm(path.join(root, '.vitest-reports'), { recursive: true, force: true });
await rm(path.join(root, 'coverage'), { recursive: true, force: true });

console.log(`Running ${shardTotal} test shards in parallel…`);

const shardRuns = Array.from({ length: shardTotal }, (_, i) => {
  const shard = i + 1;
  // Unique reportsDirectory + clean=false avoids races when shards write coverage
  // concurrently; coverage data for the merge still lives in the blob reports.
  return run(
    [
      `--shard=${shard}/${shardTotal}`,
      '--reporter=blob',
      '--coverage',
      '--coverage.clean=false',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=./coverage/.shard-${shard}`,
    ],
    { ...process.env, VITEST_PARTIAL_COVERAGE: '1' },
  ).catch((err) => {
    err.message = `shard ${shard}/${shardTotal}: ${err.message}`;
    throw err;
  });
});

const results = await Promise.allSettled(shardRuns);
const failures = results.filter((r) => r.status === 'rejected');

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.reason.message);
  }
  process.exit(1);
}

console.log('Merging shard reports and coverage…');
await run(['--merge-reports', '--coverage']);

// Drop per-shard coverage scratch dirs; merged report lives in ./coverage
for (let shard = 1; shard <= shardTotal; shard++) {
  await rm(path.join(root, 'coverage', `.shard-${shard}`), {
    recursive: true,
    force: true,
  });
}
