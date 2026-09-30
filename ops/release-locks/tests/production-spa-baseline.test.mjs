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
  acceptedBaselineCandidate,
  compareProductionSpaCandidate,
} from '../../../scripts/lib/production-spa-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lockedComponent() {
  return loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json')).components[PRODUCTION_SPA_ID];
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
  assert.equal(component.artifact.name, ACCEPTED_PRODUCTION_SPA.spa_bundle);
  assert.equal(component.artifact.hash, ACCEPTED_PRODUCTION_SPA.spa_sha256);
  assert.equal(component.artifact.version, ACCEPTED_PRODUCTION_SPA.s3_version);
  assert.equal(component.deployment_fingerprint.spa_bundle, ACCEPTED_PRODUCTION_SPA.spa_bundle);
  assert.equal(component.deployment_fingerprint.spa_sha256, ACCEPTED_PRODUCTION_SPA.spa_sha256);
  assert.equal(component.deployment_fingerprint.config_hash, ACCEPTED_PRODUCTION_SPA.index_html_sha256);
  assert.equal(component.deployment_fingerprint.cloudfront_deployment_fingerprint, ACCEPTED_PRODUCTION_SPA.s3_version);
  assert.equal(component.deployment_fingerprint.cloudfront_id, ACCEPTED_PRODUCTION_SPA.cloudfront_id);
  assert.equal(component.source.git_sha, ACCEPTED_PRODUCTION_SPA.source_lineage);
  assert.equal(component.rollback.git_sha, ACCEPTED_PRODUCTION_SPA.banner_overlay);
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
      git_sha: ACCEPTED_PRODUCTION_SPA.source_lineage,
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
    rollback: { git_sha: ACCEPTED_PRODUCTION_SPA.source_lineage, artifact: '/assets/index-BAD1KYoF.js' },
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
  const candidate = acceptedBaselineCandidate();
  assert.deepEqual(compareCandidate(manifest, candidate), []);
  assert.deepEqual(compareProductionSpaCandidate(lockedComponent(), candidate.components[PRODUCTION_SPA_ID]), []);
  const file = writeCandidate(candidate);
  assert.ok(fs.existsSync(file));
});

test('2. intentionally stale SPA candidate is rejected', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = acceptedBaselineCandidate();
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
  const candidate = acceptedBaselineCandidate();
  candidate.components[PRODUCTION_SPA_ID].live_production = {
    spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
    spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
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
        preflight_production: {
          spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
          spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
          index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
          s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
        },
        live_production: {
          spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
          spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
          index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
          s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
        },
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
  const candidate = acceptedBaselineCandidate();
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
  const mismatch = acceptedBaselineCandidate();
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

  const destructive = acceptedBaselineCandidate();
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
