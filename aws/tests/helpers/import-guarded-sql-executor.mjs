/**
 * Load the VPC SQL executor from an isolated temp copy.
 * Tests must not write packed guard libs into the tracked executor tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXECUTOR_SRC = path.join(ROOT, 'aws/write-path/guarded-sql-executor/index.mjs');
const EXECUTOR_DIR = path.join(ROOT, 'aws/write-path/guarded-sql-executor');
const GUARD_LIB = path.join(ROOT, 'scripts/deployment-guard/lib');
const LIBS = [
  'errors.mjs',
  'identity.mjs',
  'sql-apply.mjs',
  'sql-executor-auth.mjs',
  'release-sql-state.mjs',
  'release-sql-specs.mjs',
  'function-def-lookup.mjs',
  'collection-v2-synthetic-uat-cleanup.mjs',
  'tmp-rls-catalog.mjs',
];

export function repoExecutorLibDir() {
  return path.join(EXECUTOR_DIR, 'lib');
}

export async function importGuardedSqlExecutor() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-sql-executor-test-'));
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  fs.copyFileSync(EXECUTOR_SRC, path.join(staging, 'index.mjs'));
  for (const name of LIBS) {
    fs.copyFileSync(path.join(GUARD_LIB, name), path.join(staging, 'lib', name));
  }
  const module = await import(pathToFileURL(path.join(staging, 'index.mjs')).href);
  return { module, testModuleDir: staging, repoExecutorDir: EXECUTOR_DIR };
}
