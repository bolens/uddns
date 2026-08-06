#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? process.cwd());
const failures = [];

function fail(file, line, message) {
  failures.push(`${path.relative(root, file)}:${line}: ${message}`);
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

async function checkActions() {
  const files = [
    ...(await filesBelow(path.join(root, '.github', 'workflows'))),
    ...(await filesBelow(path.join(root, '.github', 'actions'))),
  ].filter((file) => /\.ya?ml$/u.test(file));

  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const reference = line.match(/^\s*uses:\s*([^\s#]+)/u)?.[1];
      if (!reference || reference.startsWith('./')) return;
      if (reference.startsWith('docker://')) {
        if (!/@sha256:[a-f0-9]{64}$/u.test(reference)) {
          fail(file, index + 1, `container action is not pinned by digest: ${reference}`);
        }
        return;
      }
      if (!/@[a-f0-9]{40}$/u.test(reference)) {
        fail(file, index + 1, `action is not pinned to a full commit SHA: ${reference}`);
      }
    });
  }
}

async function checkDockerfile() {
  const file = path.join(root, 'Dockerfile');
  const lines = (await readFile(file, 'utf8')).split('\n');
  const stages = new Set();

  for (const line of lines) {
    const stage = line.match(/^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/iu)?.[1];
    if (stage) stages.add(stage);
  }

  lines.forEach((line, index) => {
    const match = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/iu);
    if (!match) return;
    const image = match[1];
    if (image === 'scratch' || stages.has(image)) return;
    if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
      fail(file, index + 1, `base image is not pinned by digest: ${image}`);
    }
  });
}

async function checkLockfile() {
  const file = path.join(root, 'pnpm-lock.yaml');
  const lines = (await readFile(file, 'utf8')).split('\n');
  let resolutionCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s{4}resolution:/u.test(lines[index])) continue;
    resolutionCount += 1;
    let end = index + 1;
    while (end < lines.length && !/^\s{4}\S/u.test(lines[end])) end += 1;
    const block = lines.slice(index, end).join('\n');
    if (!/integrity:\s+sha(?:256|512)-[A-Za-z0-9+/=]+/u.test(block)) {
      fail(file, index + 1, 'dependency resolution has no SHA integrity value');
    }
  }

  if (resolutionCount === 0) fail(file, 1, 'no dependency resolutions found');
}

async function checkFrozenInstalls() {
  const files = await filesBelow(path.join(root, '.github', 'workflows'));
  for (const file of files.filter((entry) => /\.ya?ml$/u.test(entry))) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/\bpnpm install\b/u.test(line) && !/--frozen-lockfile\b/u.test(line)) {
        fail(file, index + 1, 'CI dependency install must use --frozen-lockfile');
      }
    });
  }
}

await Promise.all([checkActions(), checkDockerfile(), checkLockfile(), checkFrozenInstalls()]);

if (failures.length > 0) {
  console.error(`Dependency pin policy failed:\n${failures.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Dependency pin policy passed.');
}
