#!/usr/bin/env node
/**
 * Fail-closed validator for the ChecksOps locked-component manifest.
 *
 * Usage:
 *   node scripts/validate-release-locks.mjs
 *   node scripts/validate-release-locks.mjs --print-hashes
 *   node scripts/validate-release-locks.mjs --root /path/to/repo
 *
 * After this genesis PR merges, validation compares candidate lock history
 * against the trusted base-branch ledger. This process protects the release
 * workflow; it cannot independently prove live AWS state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PATHS,
  computeOwnershipHashes,
  loadJson,
  loadJsonAtRef,
  repoRootFrom,
  resolveTrustedBaseSha,
  validateReleaseLocks,
} from './lib/release-locks.mjs';

export function parseRootArg(argv, fallback) {
  const idx = argv.indexOf('--root');
  if (idx >= 0 && argv[idx + 1]) return path.resolve(argv[idx + 1]);
  return fallback;
}

export function loadReleaseLockInputs(root = repoRootFrom(import.meta.url), env = process.env) {
  const baseSha = resolveTrustedBaseSha(root, env);
  const baseLedger = baseSha ? loadJsonAtRef(root, baseSha, DEFAULT_PATHS.ledger) : { exists: false, data: null };
  const baseManifest = baseSha ? loadJsonAtRef(root, baseSha, DEFAULT_PATHS.manifest) : { exists: false, data: null };
  const baseProtected = baseSha ? loadJsonAtRef(root, baseSha, DEFAULT_PATHS.protectedPaths) : { exists: false, data: null };
  const genesis = !baseLedger.exists;
  const workflowPath = path.join(root, DEFAULT_PATHS.workflow);
  return {
    root,
    schema: loadJson(path.join(root, DEFAULT_PATHS.schema)),
    manifest: loadJson(path.join(root, DEFAULT_PATHS.manifest)),
    protectedPaths: loadJson(path.join(root, DEFAULT_PATHS.protectedPaths)),
    ledger: loadJson(path.join(root, DEFAULT_PATHS.ledger)),
    allowlist: loadJson(path.join(root, DEFAULT_PATHS.overlapAllowlist)),
    evidence: loadJson(path.join(root, DEFAULT_PATHS.evidence)),
    signatureContract: loadJson(path.join(root, DEFAULT_PATHS.signatureContract)),
    schemas: {
      ledger: loadJson(path.join(root, DEFAULT_PATHS.ledgerSchema)),
      allowlist: loadJson(path.join(root, DEFAULT_PATHS.allowlistSchema)),
      evidence: loadJson(path.join(root, DEFAULT_PATHS.evidenceSchema)),
      protectedPaths: loadJson(path.join(root, DEFAULT_PATHS.protectedPathsSchema)),
      signatureContract: loadJson(path.join(root, DEFAULT_PATHS.signatureContractSchema)),
    },
    base: {
      sha: baseSha,
      ledger: baseLedger.data,
      manifest: baseManifest.data,
      protectedPaths: baseProtected.data,
    },
    workflowText: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : null,
    genesis,
  };
}

export function main(argv = process.argv.slice(2), rootArg = repoRootFrom(import.meta.url), env = process.env) {
  const root = parseRootArg(argv, rootArg);
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
  const inputs = loadReleaseLockInputs(root, env);
  const { errors, genesis } = validateReleaseLocks(inputs);
  if (errors.length) {
    console.error('release-lock validator failed:');
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  if (genesis) {
    console.log('release-lock validator: ok (genesis ledger is the immutable starting point)');
  } else {
    console.log(`release-lock validator: ok (append-only vs trusted base ${inputs.base.sha})`);
  }
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
