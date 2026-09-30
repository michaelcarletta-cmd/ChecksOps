/**
 * Fail-closed settings/billing/branding/deposit + SPA composition lock.
 * Synthetic local tests only. Does not write AWS or production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';
import { compareCandidate } from '../../../scripts/production-deploy-guard.mjs';
import {
  APPLICATION_CANDIDATE_SHA,
  COMPOSED_SPA_CANDIDATE,
  HISTORICAL_SPA_BUNDLES,
  REGRESSION_MARKERS,
  SETTINGS_COMPONENT_ID,
  SETTINGS_SOURCE_FILES,
  TOOLING_FIX_SHA,
  compareSettingsCandidate,
  evaluateHistoricalRestore,
  evaluateReviewedBaselineMatch,
  evaluateReconcileWithLiveSource,
  REVIEWED_PRODUCTION_LAMBDA,
  REVIEWED_PRODUCTION_SPA,
  STAGING_ACCEPTANCE,
} from '../../../scripts/lib/settings-billing-branding-deposits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('settings ownership group exists and does not claim WalletOps/OCR/signature/Claim Ledger', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups[SETTINGS_COMPONENT_ID];
  assert.ok(group, 'settings-billing-branding-deposits ownership group is required');
  assert.ok(!group.paths.includes('src/pages/WalletOps.tsx'));
  assert.ok(!group.paths.includes('aws/functions/api/ocr.mjs'));
  assert.ok(!group.paths.some((rel) => rel.includes('partner-share')));
  assert.ok(group.paths.includes('scripts/lib/settings-billing-branding-deposits.mjs'));
  assert.ok(group.paths.includes('ops/release-locks/proof/settings-billing-branding-deposits-staging-acceptance.md'));
  assert.ok(group.paths.includes('ops/release-locks/proof/settings-billing-branding-deposits-production-apply.md'));
  assert.ok(group.paths.includes('scripts/deployment-guard/preflight.mjs'));
  assert.ok(group.paths.includes('scripts/deployment-guard/lib/production.mjs'));

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.equal(hashes.groups[SETTINGS_COMPONENT_ID].missing.length, 0);
  for (const rel of group.paths) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(matches.some((row) => row.groupId === SETTINGS_COMPONENT_ID), `${rel} must belong to settings group`);
  }
});

test('settings component is production-locked with deployed-code evidence and records both SHAs', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components[SETTINGS_COMPONENT_ID];
  assert.equal(component.classification, 'PRODUCTION_LOCKED');
  assert.equal(component.production_active, true);
  assert.equal(component.source.git_sha, APPLICATION_CANDIDATE_SHA);
  assert.match(component.notes, new RegExp(TOOLING_FIX_SHA));
  assert.match(component.notes, /[Hh]istorical artifact hashes are provenance/);
  assert.match(component.notes, /reconcile/);
  assert.match(component.notes, /NOT ESTABLISHED/);
  assert.match(component.notes, /item #5/);
  assert.ok(component.production_validation.evidence_refs.some((ref) => /production-apply/i.test(ref)));
  assert.equal(component.artifact.name, STAGING_ACCEPTANCE.spa_bundle);
  assert.equal(component.artifact.hash, STAGING_ACCEPTANCE.spa_sha256);
  assert.equal(component.artifact.name, COMPOSED_SPA_CANDIDATE.spa_bundle);
});

test('accepted settings/billing/branding/deposit and composition-preflight markers remain', () => {
  for (const [id, marker] of Object.entries(REGRESSION_MARKERS)) {
    const text = read(marker.file);
    if (marker.must) {
      assert.ok(text.includes(marker.must), `${id}: missing ${marker.must} in ${marker.file}`);
    }
    if (marker.must_not) {
      assert.ok(!text.includes(marker.must_not), `${id}: forbidden ${marker.must_not} in ${marker.file}`);
    }
  }
  for (const rel of SETTINGS_SOURCE_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `required source ${rel} is missing`);
  }
});

test('historical restore and live drift fail closed', () => {
  const restore = evaluateHistoricalRestore({ candidateBundle: HISTORICAL_SPA_BUNDLES[0] });
  assert.equal(restore.ok, false);
  assert.equal(restore.code, 'STALE_PACKAGE');

  const drift = evaluateReviewedBaselineMatch({
    kind: 'lambda',
    reviewed: REVIEWED_PRODUCTION_LAMBDA,
    live: { codeSha256: 'other', revisionId: 'other' },
  });
  assert.equal(drift.ok, false);
  assert.equal(drift.code, 'DEPLOYMENT_COLLISION');
  assert.ok(drift.diffs.length >= 1);

  const spaMatch = evaluateReviewedBaselineMatch({
    kind: 'spa',
    reviewed: {
      spa_bundle: REVIEWED_PRODUCTION_SPA.spa_bundle,
      spa_sha256: REVIEWED_PRODUCTION_SPA.spa_sha256,
      index_html_sha256: REVIEWED_PRODUCTION_SPA.index_html_sha256,
      s3_version: REVIEWED_PRODUCTION_SPA.s3_version,
    },
    live: {
      spa_bundle: REVIEWED_PRODUCTION_SPA.spa_bundle,
      spa_sha256: REVIEWED_PRODUCTION_SPA.spa_sha256,
      index_html_sha256: REVIEWED_PRODUCTION_SPA.index_html_sha256,
      s3_version: REVIEWED_PRODUCTION_SPA.s3_version,
    },
  });
  assert.equal(spaMatch.ok, true);

  const reconcileErrors = evaluateReconcileWithLiveSource({
    reconcile_with_live_source: false,
    source_conflict: true,
    overwrite_independent_fixes: true,
    homeowner_association: true,
  });
  assert.ok(reconcileErrors.some((row) => /reconcile/.test(row)));
  assert.ok(reconcileErrors.some((row) => /source conflict/.test(row)));
  assert.ok(reconcileErrors.some((row) => /WalletOps/.test(row)));
  assert.ok(reconcileErrors.some((row) => /homeowner/.test(row)));
});

test('production-deploy-guard refuses historical restore and still requires live reconciliation', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components[SETTINGS_COMPONENT_ID];
  assert.equal(compareSettingsCandidate(component, {
    deploy: true,
    spa_bundle: COMPOSED_SPA_CANDIDATE.spa_bundle,
    reconcile_with_live_source: true,
  }).length, 0);
  assert.ok(compareSettingsCandidate(component, { spa_bundle: '/assets/index-BPbQUNFr.js' }).some((row) => /provenance/.test(row)));
  assert.ok(compareSettingsCandidate(component, { spa_bundle: '/assets/index-DbYbvb6d.js' }).some((row) => /provenance/.test(row)));
  const candidate = {
    environment: 'production',
    approved: true,
    components: {
      [SETTINGS_COMPONENT_ID]: {
        deploy: true,
        spa_bundle: '/assets/index-CEKjixtZ.js',
        reconcile_with_live_source: true,
      },
    },
  };
  const errors = compareCandidate(manifest, candidate);
  assert.ok(errors.some((row) => /provenance/.test(row)));
});

test('full release-lock manifest still validates after the settings lock', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  assert.deepEqual(errors, []);
  assert.equal(inputs.manifest.components[SETTINGS_COMPONENT_ID].classification, 'PRODUCTION_LOCKED');
});
