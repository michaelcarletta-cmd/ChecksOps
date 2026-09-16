#!/usr/bin/env node
/**
 * Fail-closed validator for the ChecksOps locked-component manifest.
 *
 * Usage:
 *   node scripts/validate-release-locks.mjs
 *   node scripts/validate-release-locks.mjs --print-hashes
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PATHS,
  computeOwnershipHashes,
  loadJson,
  repoRootFrom,
  validateReleaseLocks,
} from './lib/release-locks.mjs';

export function loadReleaseLockInputs(root = repoRootFrom(import.meta.url)) {
  return {
    root,
    schema: loadJson(path.join(root, DEFAULT_PATHS.schema)),
    manifest: loadJson(path.join(root, DEFAULT_PATHS.manifest)),
    protectedPaths: loadJson(path.join(root, DEFAULT_PATHS.protectedPaths)),
    ledger: loadJson(path.join(root, DEFAULT_PATHS.ledger)),
  };
}

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const printHashes = argv.includes('--print-hashes');
  const protectedPaths = loadJson(path.join(root, DEFAULT_PATHS.protectedPaths));
  if (printHashes) {
    const hashes = computeOwnershipHashes(root, protectedPaths);
    process.stdout.write(`${JSON.stringify(hashes, null, 2)}\n`);
    if (hashes.errors.length) return 1;
    return 0;
  }
  if (!fs.existsSync(path.join(root, DEFAULT_PATHS.manifest))) {
    console.error('release-lock validator: locked-components.json is missing (fail closed)');
    return 2;
  }
  const inputs = loadReleaseLockInputs(root);
  const { errors } = validateReleaseLocks(inputs);
  if (errors.length) {
    console.error('release-lock validator failed:');
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  console.log('release-lock validator: ok');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
