/**
 * Official production apply writers: receipt + reviewed-baseline + no restore.
 * Does not write AWS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateProductionLambdaPolicy } from '../../scripts/deployment-guard/production-lambda-apply.mjs';
import { evaluateProductionSpaPolicy } from '../../scripts/deployment-guard/production-spa-upload.mjs';
import {
  COMPOSED_SPA_CANDIDATE,
  CURRENT_LIVE_PRODUCTION_LAMBDA,
  CURRENT_LIVE_PRODUCTION_SPA,
} from '../../scripts/lib/settings-billing-branding-deposits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeZip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-'));
  const zip = path.join(dir, 'overlay.zip');
  fs.writeFileSync(zip, 'pk');
  return zip;
}

test('production Lambda policy refuses staging, missing confirm, missing zip, and live drift', () => {
  const zip = writeZip();
  const live = {
    codeSha256: CURRENT_LIVE_PRODUCTION_LAMBDA.codeSha256,
    revisionId: CURRENT_LIVE_PRODUCTION_LAMBDA.revisionId,
  };
  assert.equal(evaluateProductionLambdaPolicy({
    environment: 'staging',
    functionName: 'checksops-staging-api',
    confirmApply: true,
    zipPath: zip,
    receiptFingerprint: live,
    immediatelyBefore: live,
  }).code, CODES.GUARD_APPLY_FORBIDDEN);

  assert.equal(evaluateProductionLambdaPolicy({
    environment: 'production',
    functionName: 'checksops-production-prep-api',
    confirmApply: false,
    zipPath: zip,
    receiptFingerprint: live,
    immediatelyBefore: live,
  }).code, CODES.GUARD_APPLY_FORBIDDEN);

  assert.equal(evaluateProductionLambdaPolicy({
    environment: 'production',
    functionName: 'checksops-production-prep-api',
    confirmApply: true,
    zipPath: '/tmp/does-not-exist.zip',
    receiptFingerprint: live,
    immediatelyBefore: live,
  }).code, CODES.STALE_PACKAGE);

  const drifted = evaluateProductionLambdaPolicy({
    environment: 'production',
    functionName: 'checksops-production-prep-api',
    confirmApply: true,
    zipPath: zip,
    receiptFingerprint: live,
    immediatelyBefore: { codeSha256: 'newer', revisionId: 'newer-rev' },
  });
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(Array.isArray(drifted.details?.diffs) && drifted.details.diffs.length >= 1);

  const allowed = evaluateProductionLambdaPolicy({
    environment: 'production',
    functionName: 'checksops-production-prep-api',
    confirmApply: true,
    zipPath: zip,
    receiptFingerprint: live,
    immediatelyBefore: live,
  });
  assert.equal(allowed.ok, true);
});

test('production SPA policy refuses historical restore, wrong entry, and live drift', () => {
  const dist = path.join(ROOT, 'dist');
  const live = {
    spa_bundle: CURRENT_LIVE_PRODUCTION_SPA.spa_bundle,
    entry_bundle: CURRENT_LIVE_PRODUCTION_SPA.spa_bundle,
    spa_sha256: CURRENT_LIVE_PRODUCTION_SPA.spa_sha256,
    index_html_sha256: CURRENT_LIVE_PRODUCTION_SPA.index_html_sha256,
    s3_version: CURRENT_LIVE_PRODUCTION_SPA.s3_version,
  };
  const receipt = {
    index_html_sha256: CURRENT_LIVE_PRODUCTION_SPA.index_html_sha256,
    entry_bundle: CURRENT_LIVE_PRODUCTION_SPA.spa_bundle,
  };

  assert.equal(evaluateProductionSpaPolicy({
    environment: 'staging',
    bucket: 'checksops-staging-frontend-c48b',
    confirmApply: true,
    distDir: dist,
    immediatelyBefore: live,
    receiptFingerprint: receipt,
  }).code, CODES.GUARD_APPLY_FORBIDDEN);

  assert.equal(evaluateProductionSpaPolicy({
    environment: 'production',
    bucket: 'checksops-production-frontend-806168576068',
    confirmApply: false,
    distDir: dist,
    immediatelyBefore: live,
    receiptFingerprint: receipt,
  }).code, CODES.GUARD_APPLY_FORBIDDEN);

  const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-spa-'));
  fs.writeFileSync(path.join(staleDir, 'index.html'), '<script src="/assets/index-BPbQUNFr.js"></script>');
  assert.equal(evaluateProductionSpaPolicy({
    environment: 'production',
    bucket: 'checksops-production-frontend-806168576068',
    confirmApply: true,
    distDir: staleDir,
    immediatelyBefore: live,
    receiptFingerprint: receipt,
  }).code, CODES.STALE_PACKAGE);

  const drifted = evaluateProductionSpaPolicy({
    environment: 'production',
    bucket: 'checksops-production-frontend-806168576068',
    confirmApply: true,
    distDir: dist,
    immediatelyBefore: {
      ...live,
      index_html_sha256: 'e'.repeat(64),
      s3_version: 'DRIFTED',
    },
    receiptFingerprint: receipt,
  });
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);

  const allowed = evaluateProductionSpaPolicy({
    environment: 'production',
    bucket: 'checksops-production-frontend-806168576068',
    confirmApply: true,
    distDir: dist,
    immediatelyBefore: live,
    receiptFingerprint: receipt,
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.candidate_entry, COMPOSED_SPA_CANDIDATE.spa_bundle);
});
