/**
 * Official production-spa-upload policy for the approved CvCKsSsX candidate.
 * Does not write AWS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateProductionSpaPolicy } from '../../scripts/deployment-guard/production-spa-upload.mjs';
import {
  COMPOSED_SPA_CANDIDATE,
  CURRENT_LIVE_PRODUCTION_SPA,
} from '../../scripts/lib/qdji-dsb-recovery-spa-pins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('production SPA policy accepts the pinned CvCKsSsX candidate against DSbVZXu8', () => {
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
  fs.writeFileSync(path.join(staleDir, 'index.html'), '<script src="/assets/index-DSbVZXu8.js"></script>');
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
  assert.equal(allowed.details.candidate_entry, '/assets/index-CvCKsSsX.js');
});
