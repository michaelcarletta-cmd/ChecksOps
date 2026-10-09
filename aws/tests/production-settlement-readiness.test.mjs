import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-settlement-readiness.json'), 'utf8'));
const LOCKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/release-locks/locked-components.json'), 'utf8'));
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/protected-targets.json'), 'utf8'));

function sha256File(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

test('readiness pin is evaluate-only CONDITIONAL and does not authorize apply', () => {
  assert.equal(PIN.id, 'production-settlement-readiness');
  assert.equal(PIN.verdict, 'CONDITIONAL');
  assert.equal(PIN.deployment_verdict, 'NO-GO');
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.write_authorized, false);
  assert.equal(PIN.sql_apply_authorized, false);
  assert.equal(PIN.lambda_or_spa_deployments, false);
  assert.equal(PIN.receipts_issued, false);
  assert.equal(PIN.production_changes, false);
  assert.equal(PIN.automatic_fixes, false);
});

test('fresh production fingerprints and SPA lock still match live pins', () => {
  assert.equal(PIN.live_production.lambda.function_name, 'checksops-production-prep-api');
  assert.equal(PIN.live_production.lambda.CodeSha256, 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=');
  assert.equal(PIN.live_production.lambda.RevisionId, 'fb17cb70-7b50-468d-a0a6-59a020c43f8c');
  assert.equal(PIN.live_production.lambda.drift_since_official_inspect, false);
  assert.equal(PIN.live_production.spa.entry_bundle, '/assets/index-CBOwj-7W.js');
  assert.equal(PIN.live_production.spa.bundle_sha256, '0b5fa51e11660cc9db224801b14edb3d80e662f0781ddce98d462448f66f3635');
  assert.equal(PIN.live_production.spa.matches_production_spa_lock, true);
  assert.equal(LOCKS.components['production-spa'].classification, 'PRODUCTION_LOCKED');
  assert.equal(LOCKS.components['production-spa'].artifact.name, '/assets/index-CBOwj-7W.js');
  assert.equal(PIN.live_staging_for_compare.identical_to_production, false);
});

test('accepted origin/main hashes match current files and live production diffs', () => {
  assert.equal(sha256File('aws/functions/api/claim-settlement-rpc.mjs'), PIN.accepted_source_on_origin_main['claim-settlement-rpc.mjs']);
  assert.equal(sha256File('aws/functions/api/data.mjs'), PIN.accepted_source_on_origin_main['data.mjs']);
  assert.equal(sha256File('aws/functions/api/workflow.mjs'), PIN.accepted_source_on_origin_main['workflow.mjs']);
  assert.equal(sha256File('aws/functions/api/workflow-rpc.mjs'), PIN.accepted_source_on_origin_main['workflow-rpc.mjs']);
  assert.equal(sha256File('aws/workflows/sql/53_claim_settlement_breakdown.sql'), PIN.accepted_source_on_origin_main['53_claim_settlement_breakdown.sql']);
  assert.equal(PIN.member_comparison.missing_or_different_forward_compose['claim-settlement-rpc.mjs'].live_sha256, null);
  assert.notEqual(
    PIN.member_comparison.missing_or_different_forward_compose['data.mjs'].live_sha256,
    PIN.member_comparison.missing_or_different_forward_compose['data.mjs'].accepted_sha256,
  );
  assert.equal(PIN.member_comparison.already_present_keep['ocr.mjs'].operation, 'keep_live');
  assert.equal(PIN.member_comparison.already_present_keep['write-claim-settlement.mjs'].live_sha256, PIN.accepted_source_on_origin_main['write-claim-settlement.mjs']);
});

test('SQL 53 is unproven in production and endorsement SQL stays out of scope', () => {
  assert.equal(PIN.live_production.sql.status, 'unproven');
  assert.equal(PIN.live_production.sql.sql53_exists, null);
  assert.equal(PIN.live_production.sql.ledger_has_sql53_apply_proof, false);
  assert.ok(PIN.forbidden_this_release.includes('SQL 39'));
  assert.ok(PIN.forbidden_this_release.includes('SQL 40'));
  assert.ok(PIN.forbidden_this_release.includes('SQL 44'));
  assert.ok(PIN.forbidden_this_release.some((row) => String(row).includes('20261007193200')));
  assert.equal(PIN.member_comparison.do_not_overlay['workflow-transitions.mjs'].operation, 'hold');
  assert.equal(PIN.outstanding.endorsement_stage_sql.includes('not required for settlement'), true);
});

test('production provider flags stay recorded as live-on and C1C remains outstanding', () => {
  assert.equal(PIN.live_production.financial_flags.AWS_PROVIDER_EXECUTION_ENABLED, true);
  assert.equal(PIN.live_production.financial_flags.AWS_MOOV_ENABLED, true);
  assert.equal(PIN.live_production.financial_flags.AWS_CHECKALT_ENABLED, true);
  assert.equal(PIN.live_production.financial_flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED, true);
  assert.equal(PIN.outstanding.c1c_cross_tenant_deny, 'outstanding and separately gated');
  assert.equal(PIN.outstanding.this_workstream_production_approval, 'not issued');
});

test('official guards require production lease, CAS, and staging acceptance', () => {
  const production = TARGETS.environments.production;
  assert.equal(production.requires_lease, true);
  assert.equal(production.requires_explicit_approval, true);
  assert.equal(production.requires_staging_acceptance, true);
  assert.equal(production.requires_second_fingerprint_before_write, true);
  const lambda = TARGETS.targets.find((row) => row.id === 'checksops-production-prep-api');
  assert.equal(lambda.overlay_required, true);
  assert.equal(lambda.full_replace_forbidden, true);
  assert.equal(lambda.revision_id_cas, true);
  assert.equal(PIN.guard_verification.official_production_lambda_gha_twin, false);
  assert.equal(PIN.guard_verification.receipts_created_this_inspection, false);
  assert.match(PIN.recommended_next_safe_action, /production SQL 53 existence\/hash inspect/);
});
