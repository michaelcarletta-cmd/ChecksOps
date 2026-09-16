#!/usr/bin/env node
/**
 * Production SPA build/deploy for the M7.5 money-test hold.
 *
 *   node scripts/deploy-production-spa.mjs
 *   CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE node scripts/deploy-production-spa.mjs --apply
 *
 * Always:
 *   1. `vite build --mode aws` (Cognito + same-origin /prep)
 *   2. validate Cognito /prep markers AND M7.5 money UI markers
 *   3. record Git commit → bundle fingerprint
 *
 * `--apply` is refused unless unlocked with M75_MONEY_TEST_HOLD_RELEASE.
 * RELEASE_CUTOVER_LOCK is no longer accepted (that is how CheckAlt #332
 * overwrote the reviewed M7.5A SPA).
 * Do not use `npm run build` or a raw `aws s3 sync`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProductionSpaArtifact } from './validate-production-spa-artifact.mjs';
import { recordProductionSpaFingerprint } from './record-production-spa-fingerprint.mjs';
import {
  PRODUCTION_SPA_LOCK,
  assertNotSupabaseArtifact,
  assertMoneyTestSpaArtifact,
  assertProductionSpaApplyAllowed,
} from './production-spa-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const DIST = path.join(ROOT, 'dist');
const PRODUCTION_SPA_S3_BUCKET = PRODUCTION_SPA_LOCK.knownGood.s3Bucket;
const PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID = PRODUCTION_SPA_LOCK.knownGood.cloudfrontDistributionId;
const AWS = process.env.AWS_CLI || 'aws';

const fail = (payload, status = 1) => {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(status);
};

if (APPLY) {
  try {
    assertProductionSpaApplyAllowed({ env: process.env });
  } catch (error) {
    fail({
      error: error.code || error.message,
      productionSpaLocked: true,
      knownGood: PRODUCTION_SPA_LOCK.knownGood,
      ...(error.extra || {}),
    }, 2);
  }
}

const runAws = (args, label) => {
  const result = spawnSync(AWS, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail({
      error: label,
      status: result.status,
      stderr: (result.stderr || '').slice(-2000),
      stdout: (result.stdout || '').slice(-500),
    });
  }
  return result;
};

const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');
const build = spawnSync(viteBin, ['build', '--mode', 'aws'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (build.status !== 0) {
  fail({
    error: 'production_spa_build_failed',
    status: build.status,
    stderr: (build.stderr || '').slice(-2000),
  }, build.status || 1);
}

const validation = scanProductionSpaArtifact(DIST);
if (!validation.ok) {
  fail({
    error: 'production_spa_artifact_rejected',
    ...validation,
  });
}
try {
  assertNotSupabaseArtifact(validation);
  assertMoneyTestSpaArtifact(validation);
} catch (error) {
  fail({
    error: error.code || error.message,
    ...validation,
    ...(error.extra || {}),
  });
}

const indexHtml = path.join(DIST, 'index.html');
if (!fs.existsSync(indexHtml)) {
  fail({ error: 'production_spa_index_missing', path: indexHtml });
}

let invalidationId = null;
if (APPLY) {
  const identityRaw = runAws(['sts', 'get-caller-identity', '--output', 'json'], 'production_spa_identity_failed');
  let identity = {};
  try { identity = JSON.parse(identityRaw.stdout || '{}'); } catch { identity = {}; }
  const callerArn = String(identity.Arn || '');
  if (!callerArn.includes('ChecksOpsProductionSpaDeploy')) {
    fail({
      error: 'production_spa_deploy_role_denied',
      approvedDeployRole: PRODUCTION_SPA_LOCK.approvedDeployRole,
      callerArn,
      hint: 'Apply must use ChecksOpsProductionSpaDeploy. ChecksOpsCursorCloudStaging and other workstream roles are refused.',
    }, 2);
  }
  try {
    assertProductionSpaApplyAllowed({ env: process.env, validation });
  } catch (error) {
    fail({
      error: error.code || error.message,
      productionSpaLocked: true,
      ...(error.extra || {}),
    }, 2);
  }
  const bucketUri = `s3://${PRODUCTION_SPA_S3_BUCKET}`;
  runAws([
    's3', 'sync', `${DIST}/`, `${bucketUri}/`,
    '--exclude', '.DS_Store',
    '--exclude', 'm75-money-test-hold.json',
    '--cache-control', 'public,max-age=31536000,immutable',
  ], 'production_spa_s3_sync_failed');
  runAws([
    's3', 'cp', indexHtml, `${bucketUri}/index.html`,
    '--cache-control', 'no-cache, no-store, must-revalidate',
    '--content-type', 'text/html; charset=utf-8',
  ], 'production_spa_index_upload_failed');
  const hold = {
    hold: 'm75b7_money_test',
    locked: true,
    until: 'M7.5B.7 complete',
    reason: PRODUCTION_SPA_LOCK.reason,
    reviewedCommit: PRODUCTION_SPA_LOCK.knownGood.gitCommit,
    moneyUi: PRODUCTION_SPA_LOCK.moneyUi,
    refuse: [
      'CheckAlt SPA deploy',
      'raw aws s3 sync',
      'unrelated frontend deploy',
      'RELEASE_CUTOVER_LOCK fingerprint restore',
      'index-DjRdsF7Y.js',
    ],
    writtenAt: new Date().toISOString(),
  };
  const holdPath = path.join(os.tmpdir(), 'm75-money-test-hold.json');
  fs.writeFileSync(holdPath, `${JSON.stringify(hold, null, 2)}\n`);
  runAws([
    's3', 'cp', holdPath, `${bucketUri}/${PRODUCTION_SPA_LOCK.s3HoldObject}`,
    '--cache-control', 'no-store',
    '--content-type', 'application/json',
  ], 'production_spa_hold_object_upload_failed');
  const invalidation = runAws([
    'cloudfront', 'create-invalidation',
    '--distribution-id', PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
    '--paths', '/*',
  ], 'production_spa_cloudfront_invalidation_failed');
  try {
    invalidationId = JSON.parse(invalidation.stdout || '{}')?.Invalidation?.Id || null;
  } catch {
    invalidationId = null;
  }
}

const fingerprintDir = path.join(ROOT, 'aws/cutover/production-spa-fingerprints');
const fingerprint = recordProductionSpaFingerprint({
  distDir: DIST,
  outPath: path.join(fingerprintDir, 'latest.json'),
  deployed: APPLY,
  deployMeta: {
    s3Bucket: PRODUCTION_SPA_S3_BUCKET,
    cloudfrontDistributionId: PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
    invalidationId,
  },
});

if (APPLY && fingerprint.gitCommit) {
  const stamp = `${fingerprint.recordedAt.replace(/[:.]/g, '-')}`;
  fs.writeFileSync(
    path.join(fingerprintDir, `production-spa-${fingerprint.gitCommit.slice(0, 12)}-${stamp}.json`),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
  );
}

console.log(JSON.stringify({
  ok: true,
  deployed: APPLY,
  mechanism: 'node scripts/deploy-production-spa.mjs',
  mode: 'aws',
  validation: {
    ok: validation.ok,
    moneyCounts: validation.moneyCounts,
    missing: validation.missing,
    forbidden: validation.forbidden,
    userPoolId: validation.userPoolId,
    clientId: validation.clientId,
    apiTarget: validation.apiTarget,
  },
  s3Bucket: PRODUCTION_SPA_S3_BUCKET,
  cloudfrontDistributionId: PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
  invalidationId,
  fingerprint: {
    gitCommit: fingerprint.gitCommit,
    recordedAt: fingerprint.recordedAt,
    spaBundle: fingerprint.spaBundle,
    authProvider: fingerprint.authProvider,
    cognito: fingerprint.cognito,
    apiTarget: fingerprint.apiTarget,
    moneyCounts: fingerprint.moneyCounts,
    deployed: fingerprint.deployed,
  },
}, null, 2));
