#!/usr/bin/env node
/**
 * Production SPA build/deploy for the M7.5 money-test hold.
 *
 *   node scripts/deploy-production-spa.mjs
 *   CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE node scripts/deploy-production-spa.mjs --apply
 *   CHECKSOPS_PRODUCTION_SPA_UNLOCK=M75_MONEY_TEST_HOLD_RELEASE node scripts/deploy-production-spa.mjs --rollback-known-good --apply
 *
 * Build path:
 *   1. `vite build --mode aws` (Cognito + same-origin /prep)
 *   2. validate Cognito /prep markers AND M7.5 money UI markers
 *   3. record Git commit → bundle fingerprint
 *
 * `--rollback-known-good` does not rebuild. It restores the lock's
 * `index-C_NPDCdc.js` index.html already present in the production bucket
 * and uploads only that file. Do not raw-sync unrelated files.
 *
 * `--apply` is refused unless unlocked with M75_MONEY_TEST_HOLD_RELEASE.
 * RELEASE_CUTOVER_LOCK is no longer accepted (that is how CheckAlt #332
 * overwrote the reviewed M7.5A SPA).
 * Do not use `npm run build` or a raw `aws s3 sync`.
 */
import { createHash } from 'node:crypto';
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
  assertHardenedProductionAuthArtifact,
  assertProductionSpaApplyAllowed,
} from './production-spa-lock.mjs';

const PRODUCTION_AWS_BUILD_ENV = Object.freeze({
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_APP_URL: 'https://checksops.com',
  VITE_CHECKSOPS_API_URL: '/prep',
  VITE_AWS_REGION: 'us-east-1',
  VITE_COGNITO_USER_POOL_ID: PRODUCTION_SPA_LOCK.knownGood.cognitoPoolId,
  VITE_COGNITO_USER_POOL_CLIENT_ID: PRODUCTION_SPA_LOCK.knownGood.cognitoClientId,
  VITE_SUPABASE_URL: '',
  VITE_SUPABASE_PUBLISHABLE_KEY: '',
  VITE_SUPABASE_PROJECT_ID: '',
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const ROLLBACK_KNOWN_GOOD = process.argv.includes('--rollback-known-good');
const DIST = path.join(ROOT, 'dist');
const PRODUCTION_SPA_S3_BUCKET = PRODUCTION_SPA_LOCK.knownGood.s3Bucket;
const PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID = PRODUCTION_SPA_LOCK.knownGood.cloudfrontDistributionId;
const AWS = process.env.AWS_CLI || 'aws';
const KNOWN_GOOD_FINGERPRINT_PATH = path.join(
  ROOT,
  'aws/cutover/production-spa-fingerprints/production-spa-a49069322624-2026-09-16T13-01-51-876Z.json',
);

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

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const knownGoodBundle = PRODUCTION_SPA_LOCK.knownGood.spaBundle;
const knownGoodFingerprint = JSON.parse(fs.readFileSync(KNOWN_GOOD_FINGERPRINT_PATH, 'utf8'));
const expectedHtmlSha = knownGoodFingerprint.bundle.assets['index.html'];
const expectedJsSha = knownGoodFingerprint.bundle.assets[`assets/${knownGoodBundle}`];
const expectedCssSha = knownGoodFingerprint.bundle.assets['assets/index-CWVpcCxc.css'];

let restoreDir = null;
if (ROLLBACK_KNOWN_GOOD) {
  restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-spa-known-good-'));
  fs.mkdirSync(path.join(restoreDir, 'assets'), { recursive: true });
  const bucketUri = `s3://${PRODUCTION_SPA_S3_BUCKET}`;
  runAws(['s3', 'cp', `${bucketUri}/index.html`, path.join(restoreDir, 'current-index.html')], 'production_spa_current_index_download_failed');
  runAws(['s3', 'cp', `${bucketUri}/assets/${knownGoodBundle}`, path.join(restoreDir, 'assets', knownGoodBundle)], 'production_spa_known_good_js_download_failed');
  runAws(['s3', 'cp', `${bucketUri}/assets/index-CWVpcCxc.css`, path.join(restoreDir, 'assets/index-CWVpcCxc.css')], 'production_spa_known_good_css_download_failed');
  const currentHtml = fs.readFileSync(path.join(restoreDir, 'current-index.html'), 'utf8');
  const restoredHtml = currentHtml.replace(/\/assets\/index-[A-Za-z0-9_-]+\.js/, `/assets/${knownGoodBundle}`);
  if (!restoredHtml.includes(`/assets/${knownGoodBundle}`)) {
    fail({ error: 'production_spa_rollback_index_missing_known_good_bundle', knownGoodBundle });
  }
  fs.writeFileSync(path.join(restoreDir, 'index.html'), restoredHtml);
  const hashes = {
    indexHtml: sha256File(path.join(restoreDir, 'index.html')),
    js: sha256File(path.join(restoreDir, 'assets', knownGoodBundle)),
    css: sha256File(path.join(restoreDir, 'assets/index-CWVpcCxc.css')),
  };
  if (hashes.indexHtml !== expectedHtmlSha || hashes.js !== expectedJsSha || hashes.css !== expectedCssSha) {
    fail({
      error: 'production_spa_rollback_fingerprint_mismatch',
      hashes,
      expected: { indexHtml: expectedHtmlSha, js: expectedJsSha, css: expectedCssSha },
    });
  }
}

if (!ROLLBACK_KNOWN_GOOD) {
  const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  const build = spawnSync(viteBin, ['build', '--mode', 'aws'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...PRODUCTION_AWS_BUILD_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    fail({
      error: 'production_spa_build_failed',
      status: build.status,
      stderr: (build.stderr || '').slice(-2000),
    }, build.status || 1);
  }
}

const artifactDir = ROLLBACK_KNOWN_GOOD ? restoreDir : DIST;
const validation = scanProductionSpaArtifact(artifactDir, {
  requireHardenedAuth: !ROLLBACK_KNOWN_GOOD,
});
if (!validation.ok) {
  fail({
    error: 'production_spa_artifact_rejected',
    ...validation,
  });
}
try {
  assertNotSupabaseArtifact(validation);
  assertMoneyTestSpaArtifact(validation);
  if (!ROLLBACK_KNOWN_GOOD) assertHardenedProductionAuthArtifact(validation);
} catch (error) {
  fail({
    error: error.code || error.message,
    ...validation,
    ...(error.extra || {}),
  });
}

const indexHtml = path.join(artifactDir, 'index.html');
if (!fs.existsSync(indexHtml)) {
  fail({ error: 'production_spa_index_missing', path: indexHtml });
}
if (ROLLBACK_KNOWN_GOOD && !fs.readFileSync(indexHtml, 'utf8').includes(knownGoodBundle)) {
  fail({ error: 'production_spa_rollback_index_not_known_good', knownGoodBundle });
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
  if (!ROLLBACK_KNOWN_GOOD) {
    runAws([
      's3', 'sync', `${DIST}/`, `${bucketUri}/`,
      '--exclude', '.DS_Store',
      '--exclude', 'm75-money-test-hold.json',
      '--cache-control', 'public,max-age=31536000,immutable',
    ], 'production_spa_s3_sync_failed');
  }
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
  distDir: artifactDir,
  outPath: ROLLBACK_KNOWN_GOOD ? null : path.join(fingerprintDir, 'latest.json'),
  deployed: APPLY,
  deployMeta: {
    s3Bucket: PRODUCTION_SPA_S3_BUCKET,
    cloudfrontDistributionId: PRODUCTION_CLOUDFRONT_DISTRIBUTION_ID,
    invalidationId,
    rollbackKnownGood: ROLLBACK_KNOWN_GOOD,
    restoredBundle: ROLLBACK_KNOWN_GOOD ? knownGoodBundle : null,
  },
});

if (APPLY && fingerprint.gitCommit) {
  const stamp = `${fingerprint.recordedAt.replace(/[:.]/g, '-')}`;
  const name = ROLLBACK_KNOWN_GOOD
    ? `production-spa-rollback-${knownGoodBundle.replace('.js', '')}-${stamp}.json`
    : `production-spa-${fingerprint.gitCommit.slice(0, 12)}-${stamp}.json`;
  fs.writeFileSync(
    path.join(fingerprintDir, name),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
  );
}

console.log(JSON.stringify({
  ok: true,
  deployed: APPLY,
  rollbackKnownGood: ROLLBACK_KNOWN_GOOD,
  restoredBundle: ROLLBACK_KNOWN_GOOD ? knownGoodBundle : null,
  mechanism: ROLLBACK_KNOWN_GOOD
    ? 'node scripts/deploy-production-spa.mjs --rollback-known-good'
    : 'node scripts/deploy-production-spa.mjs',
  mode: ROLLBACK_KNOWN_GOOD ? 'restore-known-good' : 'aws',
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
