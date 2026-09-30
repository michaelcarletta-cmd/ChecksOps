#!/usr/bin/env node
/**
 * Production deployment guard.
 *
 * Compares a release-candidate fingerprint file with the approved manifest.
 * Never calls AWS. Live comparison is intentionally unimplemented so the
 * guard stays fail-closed without production credentials.
 *
 * Usage:
 *   node scripts/production-deploy-guard.mjs
 *   node scripts/production-deploy-guard.mjs --candidate path/to/fingerprint.json
 *   CHECKSOPS_PRODUCTION_DEPLOY=1 node scripts/production-deploy-guard.mjs --candidate ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadJson,
  repoRootFrom,
  validateReleaseLocks,
} from './lib/release-locks.mjs';
import { loadReleaseLockInputs } from './validate-release-locks.mjs';
import {
  PRODUCTION_SPA_ID,
  compareProductionSpaCandidate,
} from './lib/production-spa-baseline.mjs';
import {
  SIGNATURE_WORKFLOW_ID,
  candidateTouchesSignature,
  compareSignatureCandidate,
} from './lib/signature-production-contract.mjs';

export function compareCandidate(manifest, candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    errors.push('candidate fingerprint is missing');
    return errors;
  }
  if (candidate.environment === 'production' && candidate.approved !== true) {
    errors.push('candidate claims production without approved=true');
  }
  for (const [id, component] of Object.entries(manifest.components || {})) {
    const row = candidate.components?.[id];
    if (id === SIGNATURE_WORKFLOW_ID) {
      if (row) errors.push(...compareSignatureCandidate(row));
      continue;
    }
    if (component.classification !== 'PRODUCTION_LOCKED') {
      if (row?.deploy === true || row?.production_active === true) {
        errors.push(`${id}: candidate deploys a component that is not PRODUCTION_LOCKED`);
      }
      continue;
    }
    if (id === PRODUCTION_SPA_ID) {
      errors.push(...compareProductionSpaCandidate(component, row));
      continue;
    }
    if (!row) {
      errors.push(`${id}: PRODUCTION_LOCKED component missing from candidate fingerprint`);
      continue;
    }
    if (component.artifact?.hash && row.hash && component.artifact.hash !== row.hash) {
      errors.push(`${id}: candidate artifact hash ${row.hash} does not match locked ${component.artifact.hash}`);
    }
    if (component.artifact?.hash && !row.hash) {
      errors.push(`${id}: candidate omitted artifact hash`);
    }
    if (component.deployment_fingerprint?.spa_bundle && row.spa_bundle
      && component.deployment_fingerprint.spa_bundle !== row.spa_bundle) {
      errors.push(`${id}: candidate SPA bundle does not match locked fingerprint`);
    }
    if (component.deployment_fingerprint?.lambda_version && row.lambda_version
      && component.deployment_fingerprint.lambda_version !== row.lambda_version) {
      errors.push(`${id}: candidate Lambda version does not match locked fingerprint`);
    }
  }
  if (candidateTouchesSignature(candidate) && !candidate.components?.[SIGNATURE_WORKFLOW_ID]) {
    errors.push(`${SIGNATURE_WORKFLOW_ID}: candidate deploys Signature-owned assets without reconciling the Signature contract`);
  }
  return errors;
}

export function productionIntentErrors(manifest, env = process.env) {
  const errors = [];
  const intent = env.CHECKSOPS_PRODUCTION_DEPLOY === '1'
    || env.CHECKSOPS_PRODUCTION_DEPLOY === 'APPLY'
    || env.CHECKSOPS_APPLY_PRODUCTION === '1';
  if (!intent) return errors;
  const locked = Object.values(manifest.components || {}).filter((c) => c.classification === 'PRODUCTION_LOCKED');
  if (locked.length === 0) {
    errors.push('CHECKSOPS_PRODUCTION_DEPLOY is set but no component is PRODUCTION_LOCKED');
  }
  for (const [id, component] of Object.entries(manifest.components || {})) {
    if (component.classification !== 'PRODUCTION_LOCKED' && component.production_active) {
      errors.push(`${id}: production intent with non-locked production_active component`);
    }
  }
  return errors;
}

export function liveCompareErrors(argv) {
  if (argv.includes('--live')) {
    return ['live AWS comparison is disabled; supply a recorded --candidate fingerprint instead'];
  }
  return [];
}

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), env = process.env) {
  const inputs = loadReleaseLockInputs(root);
  const { errors: manifestErrors } = validateReleaseLocks(inputs);
  const errors = [...manifestErrors, ...liveCompareErrors(argv), ...productionIntentErrors(inputs.manifest, env)];
  const idx = argv.indexOf('--candidate');
  if (idx >= 0) {
    const candidatePath = argv[idx + 1];
    if (!candidatePath || !fs.existsSync(path.resolve(root, candidatePath))) {
      errors.push('candidate fingerprint file is missing');
    } else {
      const candidate = loadJson(path.resolve(root, candidatePath));
      errors.push(...compareCandidate(inputs.manifest, candidate));
    }
  } else if (env.CHECKSOPS_PRODUCTION_DEPLOY === '1' || env.CHECKSOPS_PRODUCTION_DEPLOY === 'APPLY') {
    errors.push('production deploy intent requires --candidate fingerprint');
  }
  if (errors.length) {
    console.error('production deploy guard failed:');
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  console.log('production deploy guard: ok (no production unlock; fail-closed)');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
