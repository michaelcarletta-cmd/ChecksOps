#!/usr/bin/env node
/**
 * Production SPA rollback may restore ONLY a previously validated
 * AWS/Cognito fingerprint. Supabase-mode artifacts are refused.
 * --apply still requires CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_SPA_LOCK,
  assertProductionSpaApplyAllowed,
  listValidatedProductionFingerprints,
} from './production-spa-lock.mjs';

const APPLY = process.argv.includes('--apply');

const fail = (payload, status = 2) => {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(status);
};

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    error: PRODUCTION_SPA_LOCK.applyRefusedError,
    allowedFingerprints: listValidatedProductionFingerprints().map((row) => ({
      file: row.name,
      gitCommit: row.data.gitCommit,
      authProvider: row.data.authProvider,
    })),
    hint: 'Rollback apply is locked. Only a validated AWS/Cognito fingerprint can be restored, and only with CHECKSOPS_PRODUCTION_SPA_UNLOCK=RELEASE_CUTOVER_LOCK --from-fingerprint <file> --apply.',
  }, null, 2));
  process.exit(0);
}

let fingerprint;
try {
  fingerprint = assertProductionSpaApplyAllowed({ argv: process.argv, env: process.env });
} catch (error) {
  fail({
    error: error.code || error.message,
    productionSpaLocked: true,
    ...(error.extra || {}),
  });
}

const deploy = spawnSync(process.execPath, [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'deploy-production-spa.mjs'),
  '--apply',
  '--from-fingerprint',
  process.argv[process.argv.indexOf('--from-fingerprint') + 1],
], {
  encoding: 'utf8',
  env: process.env,
});
if (deploy.status !== 0) {
  fail({
    error: 'production_spa_rollback_apply_failed',
    status: deploy.status,
    stderr: (deploy.stderr || '').slice(-2000),
    stdout: (deploy.stdout || '').slice(-500),
    fingerprintCommit: fingerprint.gitCommit,
  }, deploy.status || 2);
}
console.log(deploy.stdout);
