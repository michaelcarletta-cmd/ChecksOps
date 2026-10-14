/**
 * Loads the staging guarded SQL executor (aws/write-path/guarded-sql-executor/index.mjs)
 * from an isolated temporary copy, so production tools can reuse its exported
 * read-only catalog fingerprints instead of re-deriving them.
 *
 * The executor imports './lib/*.mjs', which are packed from
 * scripts/deployment-guard/lib only when the Lambda is built; the tracked
 * executor tree has no lib/ directory and must not gain one. This copies the
 * executor and exactly the guard libraries it (transitively) imports into a
 * fresh temp directory and imports it from there. Importing the module has no
 * side effects: it defines functions and constants, and its handler only runs
 * when invoked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRootFrom } from './paths.mjs';

export const STAGING_EXECUTOR_REL = 'aws/write-path/guarded-sql-executor/index.mjs';
const GUARD_LIB_REL = 'scripts/deployment-guard/lib';
const LIB_IMPORT_RE = /from\s+'\.\/(?:lib\/)?([A-Za-z0-9_.-]+\.mjs)'/g;

/** Guard library file names a module imports as './lib/x.mjs' (executor) or './x.mjs' (a lib). */
function libImports(text) {
  return [...String(text).matchAll(LIB_IMPORT_RE)].map((match) => match[1]);
}

/** The executor plus the closure of guard libraries it imports. */
export function stagingExecutorMembers(root = repoRootFrom(import.meta.url)) {
  const executor = path.join(root, STAGING_EXECUTOR_REL);
  const pending = libImports(fs.readFileSync(executor, 'utf8'));
  const libs = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (libs.has(name)) continue;
    const file = path.join(root, GUARD_LIB_REL, name);
    if (!fs.existsSync(file)) throw new Error(`staging executor imports a missing guard library: ${name}`);
    libs.add(name);
    pending.push(...libImports(fs.readFileSync(file, 'utf8')));
  }
  return { executor, libs: [...libs].sort() };
}

const cache = new Map();

export function loadStagingSqlExecutor(root = repoRootFrom(import.meta.url)) {
  if (!cache.has(root)) {
    cache.set(root, (async () => {
      const { executor, libs } = stagingExecutorMembers(root);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-staging-executor-readers-'));
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.copyFileSync(executor, path.join(dir, 'index.mjs'));
      for (const name of libs) fs.copyFileSync(path.join(root, GUARD_LIB_REL, name), path.join(dir, 'lib', name));
      return import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    })());
  }
  return cache.get(root);
}
