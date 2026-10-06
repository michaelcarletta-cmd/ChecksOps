/**
 * Fail-closed production SPA baseline guards.
 * Synthetic local tests only. Does not write AWS or production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classificationErrors,
  isSpaOnlyProductionLock,
  loadJson,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { compareCandidate } from '../../../scripts/production-deploy-guard.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';
import {
  ACCEPTED_PRODUCTION_SPA,
  PRODUCTION_SPA_ID,
  SAFE_SPA_DEPLOY_MODE,
  compareProductionSpaCandidate,
} from '../../../scripts/lib/production-spa-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lockedComponent() {
  return loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json')).components[PRODUCTION_SPA_ID];
}

function currentPins(component = lockedComponent()) {
  const fp = component.deployment_fingerprint || {};
  return {
    spa_bundle: fp.spa_bundle,
    spa_sha256: fp.spa_sha256,
    index_html_sha256: fp.config_hash,
    s3_version: fp.cloudfront_deployment_fingerprint,
  };
}

function currentBaselineCandidate({ deploy = true } = {}) {
  const pins = currentPins();
  return {
    environment: 'production',
    approved: true,
    components: {
      [PRODUCTION_SPA_ID]: {
        deploy,
        hash: pins.spa_sha256,
        spa_bundle: pins.spa_bundle,
        index_html_sha256: pins.index_html_sha256,
        s3_version: pins.s3_version,
        based_on_baseline: { ...pins },
        preflight_production: { ...pins },
        live_production: { ...pins },
        deploy_mode: SAFE_SPA_DEPLOY_MODE,
        contains_accepted_baseline: true,
        reconciled_to_production_baseline: true,
      },
    },
  };
}

function writeCandidate(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-spa-candidate-'));
  const file = path.join(dir, 'candidate.json');
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

test('production-spa lock records the accepted live baseline', () => {
  const component = lockedComponent();
  assert.equal(component.classification, 'PRODUCTION_LOCKED');
  assert.equal(component.production_active, true);
  assert.equal(component.artifact.type, 'spa');
  assert.equal(component.artifact.name, '/assets/index-CBOwj-7W.js');
  assert.equal(component.artifact.hash, '0b5fa51e11660cc9db224801b14edb3d80e662f0781ddce98d462448f66f3635');
  assert.equal(component.artifact.version, 'b783nvvtXDmYHqatwJVZeKx2uHcwpDk3');
  assert.equal(component.deployment_fingerprint.spa_bundle, '/assets/index-CBOwj-7W.js');
  assert.equal(component.deployment_fingerprint.spa_sha256, '0b5fa51e11660cc9db224801b14edb3d80e662f0781ddce98d462448f66f3635');
  assert.equal(component.deployment_fingerprint.config_hash, 'daff2ae4ffa654736fd05c07d05df3a790319fbf644028ca86754790f8dc7477');
  assert.equal(component.deployment_fingerprint.cloudfront_deployment_fingerprint, 'b783nvvtXDmYHqatwJVZeKx2uHcwpDk3');
  assert.equal(component.deployment_fingerprint.cloudfront_id, ACCEPTED_PRODUCTION_SPA.cloudfront_id);
  assert.notEqual(component.artifact.name, ACCEPTED_PRODUCTION_SPA.spa_bundle);
  assert.notEqual(component.artifact.name, '/assets/index-Bbftik1r.js');
  assert.equal(component.rollback.artifact, ACCEPTED_PRODUCTION_SPA.spa_bundle);
  assert.equal(isSpaOnlyProductionLock(component), true);
  assert.deepEqual(component.required_sql, []);
  assert.deepEqual(component.missing_evidence, []);
});

test('SPA-only PRODUCTION_LOCKED with empty SQL is allowed only with recorded spa identity', () => {
  const ok = classificationErrors({
    classification: 'PRODUCTION_LOCKED',
    production_active: true,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [],
    artifact: { type: 'spa', hash: ACCEPTED_PRODUCTION_SPA.spa_sha256 },
    production_validation: {
      completed: true,
      environment: 'production',
      component: 'production-spa',
      git_sha: ACCEPTED_PRODUCTION_SPA.banner_overlay,
      artifact_identity: ACCEPTED_PRODUCTION_SPA.spa_bundle,
      recorded_at: ACCEPTED_PRODUCTION_SPA.accepted_at,
      evidence_producer: 'test',
      evidence_type: 'fixture',
      evidence_refs: ['ops/release-locks/proof/production-spa-baseline.md'],
    },
    deployment_fingerprint: {
      recorded: true,
      spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
      spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
    },
    rollback: { git_sha: ACCEPTED_PRODUCTION_SPA.source_lineage, artifact: '/assets/index-BPbQUNFr.js' },
    missing_evidence: [],
  }, 'production-spa', ROOT);
  assert.equal(ok.some((row) => /required_sql/.test(row)), false);

  const missingIdentity = classificationErrors({
    classification: 'PRODUCTION_LOCKED',
    production_active: true,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [],
    artifact: { type: 'spa', hash: ACCEPTED_PRODUCTION_SPA.spa_sha256 },
    production_validation: { completed: false },
    deployment_fingerprint: { recorded: true },
    rollback: { git_sha: null, artifact: null, notes: 'none' },
    missing_evidence: ['artifact'],
  }, 'identity-cognito');
  assert.ok(missingIdentity.some((row) => /required_sql/.test(row)));
});

test('1. current accepted baseline passes production-spa preflight', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = currentBaselineCandidate();
  assert.deepEqual(compareCandidate(manifest, candidate), []);
  assert.deepEqual(compareProductionSpaCandidate(lockedComponent(), candidate.components[PRODUCTION_SPA_ID]), []);
  const file = writeCandidate(candidate);
  assert.ok(fs.existsSync(file));
});

test('2. intentionally stale SPA candidate is rejected', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = currentBaselineCandidate();
  candidate.components[PRODUCTION_SPA_ID] = {
    ...candidate.components[PRODUCTION_SPA_ID],
    hash: '0'.repeat(64),
    spa_bundle: '/assets/index-BAD1KYoF.js',
    based_on_baseline: {
      spa_bundle: '/assets/index-BAD1KYoF.js',
      spa_sha256: '0'.repeat(64),
      index_html_sha256: '1'.repeat(64),
      s3_version: 'stale-version',
    },
    contains_accepted_baseline: false,
    reconciled_to_production_baseline: false,
    source_branch: 'main',
  };
  const errors = compareCandidate(manifest, candidate);
  assert.ok(errors.some((row) => /stale SPA candidate/.test(row)));
  assert.ok(errors.some((row) => /based_on_baseline does not match/.test(row)));
  assert.ok(errors.some((row) => /unreconciled main/.test(row)));
});

test('3. production index.html/version change after preflight is rejected', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = currentBaselineCandidate();
  const pins = currentPins();
  candidate.components[PRODUCTION_SPA_ID].live_production = {
    spa_bundle: pins.spa_bundle,
    spa_sha256: pins.spa_sha256,
    index_html_sha256: 'e'.repeat(64),
    s3_version: 'DRIFTED.VERSION',
  };
  const errors = compareCandidate(manifest, candidate);
  assert.ok(errors.some((row) => /TOCTOU/.test(row)));
  assert.ok(errors.some((row) => /does not match locked baseline/.test(row)));
});

test('4. candidate missing the accepted baseline is rejected', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = {
    environment: 'production',
    approved: true,
    components: {
      [PRODUCTION_SPA_ID]: {
        deploy: true,
        hash: 'f'.repeat(64),
        spa_bundle: '/assets/index-FromMainOnly.js',
        source_branch: 'main',
        unreconciled_main: true,
        contains_accepted_baseline: false,
        reconciled_to_production_baseline: false,
        deploy_mode: SAFE_SPA_DEPLOY_MODE,
        preflight_production: currentPins(),
        live_production: currentPins(),
      },
    },
  };
  const errors = compareCandidate(manifest, candidate);
  assert.ok(errors.some((row) => /missing the accepted production baseline/.test(row)));
  assert.ok(errors.some((row) => /unreconciled main/.test(row)));
  assert.ok(errors.some((row) => /drops accepted production baseline/.test(row)));
});

test('5. current baseline plus a narrow future overlay is allowed through preflight', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = currentBaselineCandidate();
  candidate.components[PRODUCTION_SPA_ID] = {
    ...candidate.components[PRODUCTION_SPA_ID],
    hash: 'a1'.repeat(32),
    spa_bundle: '/assets/index-FutureOverlay.js',
    contains_accepted_baseline: true,
    reconciled_to_production_baseline: true,
    source_branch: 'cursor/future-overlay',
  };
  assert.deepEqual(compareCandidate(manifest, candidate), []);
});

test('lock/live mismatch and destructive overwrite fail closed', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const mismatch = currentBaselineCandidate();
  mismatch.components[PRODUCTION_SPA_ID].preflight_production = {
    spa_bundle: '/assets/index-Unexpected.js',
    spa_sha256: 'c'.repeat(64),
    index_html_sha256: 'd'.repeat(64),
    s3_version: 'OTHER',
  };
  mismatch.components[PRODUCTION_SPA_ID].live_production = {
    spa_bundle: '/assets/index-Unexpected.js',
    spa_sha256: 'c'.repeat(64),
    index_html_sha256: 'd'.repeat(64),
    s3_version: 'OTHER',
  };
  const mismatchErrors = compareCandidate(manifest, mismatch);
  assert.ok(mismatchErrors.some((row) => /does not match locked baseline/.test(row)));
  assert.equal(mismatchErrors.some((row) => /TOCTOU/.test(row)), false);

  const destructive = currentBaselineCandidate();
  destructive.components[PRODUCTION_SPA_ID].deploy_mode = 's3_sync_delete';
  const destructiveErrors = compareCandidate(manifest, destructive);
  assert.ok(destructiveErrors.some((row) => /destructive frontend deployment/.test(row)));
});

test('full release-lock manifest still validates after the SPA freeze', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  assert.deepEqual(errors, []);
  assert.equal(inputs.manifest.components[PRODUCTION_SPA_ID].classification, 'PRODUCTION_LOCKED');
});
