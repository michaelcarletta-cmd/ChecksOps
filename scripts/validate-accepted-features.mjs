#!/usr/bin/env node
/**
 * Evaluate-only accepted-feature registry CLI.
 *
 * Always exits 0 while the foundation is evaluate-only.
 * Does not acquire leases, issue receipts, call AWS, apply SQL,
 * update Release Locks, or block merge/deploy.
 *
 * Usage:
 *   node scripts/validate-accepted-features.mjs
 *   node scripts/validate-accepted-features.mjs --json
 *   node scripts/validate-accepted-features.mjs --root /path/to/repo
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateRepo,
  loadJson,
  repoRootFrom,
} from './lib/accepted-features.mjs';

export function parseRootArg(argv, fallback) {
  const idx = argv.indexOf('--root');
  if (idx >= 0 && argv[idx + 1]) return path.resolve(argv[idx + 1]);
  return fallback;
}

function loadOptionalJson(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx < 0 || !argv[idx + 1]) return null;
  return loadJson(path.resolve(argv[idx + 1]));
}

export function main(argv = process.argv.slice(2), rootArg = repoRootFrom(import.meta.url)) {
  if (argv.includes('--enforce')) {
    process.stderr.write('accepted-features: --enforce is ignored; foundation is evaluate-only and cannot block\n');
  }
  const root = parseRootArg(argv, rootArg);
  const result = evaluateRepo(root, {
    mode: 'evaluate-only',
    attestation: loadOptionalJson(argv, '--attestation'),
    composition: loadOptionalJson(argv, '--composition'),
    previous_registry: loadOptionalJson(argv, '--previous-registry'),
  });
  const payload = {
    evaluate_only: true,
    blocking: false,
    exit_code: 0,
    registry_ok: result.registry_ok,
    expected_accepted: result.expected_accepted,
    present_accepted: result.present_accepted,
    missing_accepted: result.missing_accepted,
    inventory_only: result.inventory_only,
    missing_from_main: result.missing_from_main,
    superseded: result.superseded,
    withdrawn: result.withdrawn,
    failing_invariants: result.failing_invariants,
    findings: result.findings,
    features: result.features,
    composition: result.composition,
    attestation: result.attestation,
    note: 'evaluate-only findings do not block merge or deploy',
  };
  if (argv.includes('--json') || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`accepted-features evaluate-only blocking=${payload.blocking} findings=${payload.findings.length}\n`);
    for (const row of payload.findings) {
      process.stdout.write(`- ${row.code} ${row.feature_id || '-'} ${row.invariant_id || '-'} ${row.message}\n`);
    }
  }
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
