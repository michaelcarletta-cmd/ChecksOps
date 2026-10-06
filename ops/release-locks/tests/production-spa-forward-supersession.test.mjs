/**
 * Narrow production-spa forward-supersession tests.
 * Synthetic local tests only. Does not write AWS or production.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  loadJson,
} from '../../../scripts/lib/release-locks.mjs';
import { compareCandidate } from '../../../scripts/production-deploy-guard.mjs';
import {
  ACCEPTED_PRODUCTION_SPA,
  PRODUCTION_SPA_ID,
  SAFE_SPA_DEPLOY_MODE,
  acceptedBaselineCandidate,
  applyProductionSpaLockAdvance,
  compareProductionSpaCandidate,
  evaluateForwardSupersession,
  planProductionSpaLockAdvance,
} from '../../../scripts/lib/production-spa-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function lockedComponent() {
  return loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json')).components[PRODUCTION_SPA_ID];
}

function lockedPins() {
  return {
    spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
    spa_sha256: ACCEPTED_PRODUCTION_SPA.spa_sha256,
    index_html_sha256: ACCEPTED_PRODUCTION_SPA.index_html_sha256,
    s3_version: ACCEPTED_PRODUCTION_SPA.s3_version,
  };
}

const LIVE_B = Object.freeze({
  spa_bundle: '/assets/index-Bbftik1r.js',
  spa_sha256: '67d5aceef8fb4c94262d58d205e51b1f7f3ece620d102bae19582bb08e3af59c',
  index_html_sha256: 'ac1dc285c0af1a6046d484bde94aff9b4e4238f52df5b4d24f5c8a9e3252820e',
  s3_version: 'FDsQYX2a0C8ZEs_H6h.gpmNHZ314YVPf',
});

const CANDIDATE_C = Object.freeze({
  spa_bundle: '/assets/index-CBOwj-7W.js',
  spa_sha256: '0b5fa51e11660cc9db224801b14edb3d80e662f0781ddce98d462448f66f3635',
  index_html_sha256: 'daff2ae4ffa654736fd05c07d05df3a790319fbf644028ca86754790f8dc7477',
});

const NOW = Date.parse('2026-10-06T20:00:00.000Z');

function validReceipt(overrides = {}) {
  return {
    workstream_id: 'branding-production-deploy',
    mac: 'ab'.repeat(32),
    expiry: '2026-10-06T20:10:00.000Z',
    consumed: false,
    ...overrides,
  };
}

function validLease(overrides = {}) {
  return {
    present: true,
    expired: false,
    workstream_id: 'branding-production-deploy',
    ...overrides,
  };
}

function validSupersessionRow(overrides = {}) {
  return {
    deploy: true,
    production_deploy_intent: true,
    forward_supersession: true,
    hash: CANDIDATE_C.spa_sha256,
    spa_sha256: CANDIDATE_C.spa_sha256,
    spa_bundle: CANDIDATE_C.spa_bundle,
    index_html_sha256: CANDIDATE_C.index_html_sha256,
    based_on_baseline: lockedPins(),
    historical_locked_baseline: lockedPins(),
    reconciled_against_live: { ...LIVE_B },
    preflight_production: { ...LIVE_B },
    live_production: { ...LIVE_B },
    deploy_mode: SAFE_SPA_DEPLOY_MODE,
    accepted_source_composition: true,
    required_live_behavior_preserved: true,
    accepted_feature_contracts_passed: true,
    preservation_evidence: {
      required_live_behavior_preserved: true,
      live_only_risks: [],
      passed_contracts: [
        'branding-intended-invariants',
        'aws-spa-bootstrap',
        'claim-ledger',
      ],
    },
    source: {
      git_sha: '309d6d84f38dc8bab0374b55f8fa7315f52be6d7',
      tree_hash: '6ea1f17295f90b28257a0b77060e5310a67e1a72000000000000000000000000',
    },
    lease: validLease(),
    receipt: validReceipt(),
    ...overrides,
  };
}

function candidateDoc(row) {
  return {
    environment: 'production',
    approved: true,
    production_deploy_intent: true,
    components: { [PRODUCTION_SPA_ID]: row },
  };
}

test('live == locked + ordinary candidate keeps existing authorization', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const candidate = acceptedBaselineCandidate();
  assert.deepEqual(compareCandidate(manifest, candidate), []);
  assert.deepEqual(compareProductionSpaCandidate(lockedComponent(), candidate.components[PRODUCTION_SPA_ID]), []);
});

test('live != locked + ordinary deployment is still REFUSED', () => {
  const row = acceptedBaselineCandidate().components[PRODUCTION_SPA_ID];
  row.preflight_production = { ...LIVE_B };
  row.live_production = { ...LIVE_B };
  const errors = compareProductionSpaCandidate(lockedComponent(), row);
  assert.ok(errors.some((rowError) => /does not match locked baseline/.test(rowError)));
  assert.equal(errors.some((rowError) => /forward supersession/.test(rowError)), false);
});

test('live != locked + only reconciled_to_production_baseline=true is REFUSED', () => {
  const row = validSupersessionRow({
    forward_supersession: undefined,
    production_deploy_intent: undefined,
    reconciled_to_production_baseline: true,
    lease: undefined,
    receipt: undefined,
    preservation_evidence: undefined,
  });
  const errors = compareProductionSpaCandidate(lockedComponent(), row);
  assert.ok(errors.some((rowError) => /does not match locked baseline/.test(rowError)));
  assert.equal(errors.some((rowError) => /forward supersession authorized/.test(rowError)), false);
});

test('live != locked + fake/stale supersession evidence is REFUSED', () => {
  const row = validSupersessionRow({
    receipt: { workstream_id: 'x', mac: 'not-a-mac' },
    lease: { present: true, expired: false, workstream_id: 'x' },
  });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /receipt is invalid or forged/.test(rowError)));
});

test('candidate reconciled against a different live fingerprint is REFUSED', () => {
  const row = validSupersessionRow({
    reconciled_against_live: {
      ...LIVE_B,
      spa_bundle: '/assets/index-OtherLive.js',
      spa_sha256: '11'.repeat(32),
    },
  });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /reconciled against a different live fingerprint/.test(rowError)));
});

test('live changes after supersession preflight is REFUSED', () => {
  const row = validSupersessionRow({
    live_production: {
      ...LIVE_B,
      index_html_sha256: '22'.repeat(32),
      s3_version: 'DRIFTED',
    },
  });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /live changed after supersession preflight/.test(rowError)));
});

test('missing source identity is REFUSED', () => {
  const row = validSupersessionRow({ source: { git_sha: null, tree_hash: null } });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /missing source identity/.test(rowError)));

  const gitShaTree = compareProductionSpaCandidate(lockedComponent(), validSupersessionRow({
    source: {
      git_sha: '309d6d84f38dc8bab0374b55f8fa7315f52be6d7',
      tree_hash: '6ea1f17295f90b28257a0b77060e5310a67e1a72',
    },
  }), { now: NOW });
  assert.ok(gitShaTree.some((rowError) => /missing source identity/.test(rowError)));
});

test('missing preservation/accepted-feature evidence is REFUSED', () => {
  const row = validSupersessionRow({
    accepted_feature_contracts_passed: false,
    required_live_behavior_preserved: false,
    preservation_evidence: { passed_contracts: [], live_only_risks: ['company branding'] },
  });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /accepted-feature\/regression contract evidence/.test(rowError)));
  assert.ok(errors.some((rowError) => /preservation evidence/.test(rowError)));
});

test('invalid/expired/reused receipt is REFUSED', () => {
  const expired = compareProductionSpaCandidate(lockedComponent(), validSupersessionRow({
    receipt: validReceipt({ expiry: '2026-10-06T19:00:00.000Z' }),
  }), { now: NOW });
  assert.ok(expired.some((rowError) => /receipt has expired/.test(rowError)));

  const reused = compareProductionSpaCandidate(lockedComponent(), validSupersessionRow({
    receipt: validReceipt({ consumed: true }),
  }), { now: NOW });
  assert.ok(reused.some((rowError) => /already been consumed/.test(rowError)));
});

test('missing lease is REFUSED', () => {
  const row = validSupersessionRow({ lease: null });
  const errors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.ok(errors.some((rowError) => /requires an active lease/.test(rowError)));
});

test('valid explicit forward supersession with all evidence is AUTHORIZED', () => {
  const row = validSupersessionRow();
  const compareErrors = compareProductionSpaCandidate(lockedComponent(), row, { now: NOW });
  assert.deepEqual(compareErrors, []);
  const evaluated = evaluateForwardSupersession(lockedComponent(), row, { now: NOW });
  assert.equal(evaluated.authorized, true);
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  assert.deepEqual(compareCandidate(manifest, candidateDoc(row), { now: NOW }), []);
});

test('successful verified supersession advances the lock to the newly deployed candidate', () => {
  const current = lockedComponent();
  const deployed = {
    ...CANDIDATE_C,
    hash: CANDIDATE_C.spa_sha256,
    s3_version: 'NEW.S3.VERSION',
    source: {
      git_sha: '309d6d84f38dc8bab0374b55f8fa7315f52be6d7',
      tree_hash: '6ea1f17295f90b28257a0b77060e5310a67e1a72000000000000000000000000',
    },
  };
  const planned = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed,
    liveBefore: LIVE_B,
    verified: {
      ok: true,
      after_production: {
        spa_bundle: CANDIDATE_C.spa_bundle,
        spa_sha256: CANDIDATE_C.spa_sha256,
        index_html_sha256: CANDIDATE_C.index_html_sha256,
        s3_version: 'NEW.S3.VERSION',
      },
      recorded_at: '2026-10-06T20:05:00.000Z',
    },
  });
  assert.equal(planned.advance, true, planned.errors.join('; '));
  assert.equal(planned.component.artifact.name, CANDIDATE_C.spa_bundle);
  assert.equal(planned.component.artifact.hash, CANDIDATE_C.spa_sha256);
  assert.equal(planned.component.deployment_fingerprint.spa_bundle, CANDIDATE_C.spa_bundle);
  assert.equal(planned.component.rollback.artifact, ACCEPTED_PRODUCTION_SPA.spa_bundle);
  assert.notEqual(planned.component.artifact.name, LIVE_B.spa_bundle);

  const applied = applyProductionSpaLockAdvance(
    { components: { [PRODUCTION_SPA_ID]: current } },
    planned,
    { verified: { ok: true } },
  );
  assert.equal(applied.advanced, true);
  assert.equal(applied.component.artifact.name, CANDIDATE_C.spa_bundle);
  assert.equal(current.artifact.name, ACCEPTED_PRODUCTION_SPA.spa_bundle);
});

test('failure before/while deploying does not advance the lock', () => {
  const current = lockedComponent();
  const deployed = {
    ...CANDIDATE_C,
    hash: CANDIDATE_C.spa_sha256,
    source: {
      git_sha: '309d6d84f38dc8bab0374b55f8fa7315f52be6d7',
      tree_hash: '6ea1f17295f90b28257a0b77060e5310a67e1a72000000000000000000000000',
    },
  };
  const failedPlan = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed,
    liveBefore: LIVE_B,
    failed: true,
  });
  assert.equal(failedPlan.advance, false);
  assert.equal(failedPlan.component.artifact.name, ACCEPTED_PRODUCTION_SPA.spa_bundle);

  const unverified = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed,
    liveBefore: LIVE_B,
    verified: { ok: false },
  });
  assert.equal(unverified.advance, false);

  const planned = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed,
    liveBefore: LIVE_B,
  });
  const appliedFailed = applyProductionSpaLockAdvance(
    { components: { [PRODUCTION_SPA_ID]: current } },
    planned,
    { failed: true, verified: { ok: false } },
  );
  assert.equal(appliedFailed.advanced, false);
  assert.equal(appliedFailed.manifest.components[PRODUCTION_SPA_ID].artifact.name, ACCEPTED_PRODUCTION_SPA.spa_bundle);

  const blessLive = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed: { ...LIVE_B, hash: LIVE_B.spa_sha256, source: deployed.source },
    liveBefore: LIVE_B,
    verified: { ok: true, after_production: LIVE_B },
  });
  assert.equal(blessLive.advance, false);
  assert.ok(blessLive.errors.some((row) => /unexplained live bundle/.test(row)));

  const gitShaTree = planProductionSpaLockAdvance({
    currentComponent: current,
    deployed: {
      ...CANDIDATE_C,
      hash: CANDIDATE_C.spa_sha256,
      source: {
        git_sha: '309d6d84f38dc8bab0374b55f8fa7315f52be6d7',
        tree_hash: '6ea1f17295f90b28257a0b77060e5310a67e1a72',
      },
    },
    liveBefore: LIVE_B,
    verified: {
      ok: true,
      after_production: { ...CANDIDATE_C, s3_version: 'NEW.S3.VERSION' },
    },
  });
  assert.equal(gitShaTree.advance, false);
  assert.ok(gitShaTree.errors.some((row) => /git SHA\/tree/.test(row)));
});

test('ordinary overlay and lock/live mismatch behavior remain unchanged', () => {
  const manifest = { components: { [PRODUCTION_SPA_ID]: lockedComponent() } };
  const overlay = acceptedBaselineCandidate();
  overlay.components[PRODUCTION_SPA_ID] = {
    ...overlay.components[PRODUCTION_SPA_ID],
    hash: 'a1'.repeat(32),
    spa_bundle: '/assets/index-FutureOverlay.js',
    contains_accepted_baseline: true,
    reconciled_to_production_baseline: true,
    source_branch: 'cursor/future-overlay',
  };
  assert.deepEqual(compareCandidate(manifest, overlay), []);

  const mismatch = acceptedBaselineCandidate();
  mismatch.components[PRODUCTION_SPA_ID].preflight_production = { ...LIVE_B };
  mismatch.components[PRODUCTION_SPA_ID].live_production = { ...LIVE_B };
  const mismatchErrors = compareCandidate(manifest, mismatch);
  assert.ok(mismatchErrors.some((row) => /does not match locked baseline/.test(row)));
});
