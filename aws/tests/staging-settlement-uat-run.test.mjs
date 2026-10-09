import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-settlement-uat-run.json'), 'utf8'));

function sha256File(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

test('staging settlement UAT pin is PASS and stays staging-only', () => {
  assert.equal(PIN.id, 'staging-settlement-uat-run');
  assert.equal(PIN.verdict, 'PASS');
  assert.equal(PIN.stopped, null);
  assert.equal(PIN.passed, 19);
  assert.equal(PIN.failed, 0);
  assert.equal(PIN.target_environment, 'staging');
  assert.equal(PIN.production_changes, false);
  assert.equal(PIN.production_ready, false);
  assert.equal(PIN.sql_migrations, false);
  assert.equal(PIN.lambda_or_spa_deployments, false);
  assert.equal(PIN.release_lock_changes, false);
  assert.equal(PIN.cognito_or_permission_changes, false);
  assert.equal(PIN.provider_invocations, false);
  assert.equal(PIN.c1c_cross_tenant_test_executed, false);
  assert.deepEqual(PIN.issues_requiring_correction, []);
});

test('verified Freedom admin actor and synthetic IDs are recorded', () => {
  assert.equal(PIN.actor.application_user_id, '7dbb3009-f059-4767-b5dc-1c5c72379330');
  assert.equal(PIN.actor.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(PIN.actor.tenant_role, 'admin');
  assert.equal(PIN.actor.is_master_owner, false);
  assert.equal(PIN.preflight.identity_me.isMasterOwner, false);
  assert.equal(PIN.preflight.identity_me.environment, 'staging');
  assert.equal(PIN.reserved_claim_number, 'AWS SETTLEMENT UAT');
  assert.equal(PIN.synthetic_claim_id, '38eb9c7d-fbd5-4d39-9937-40fe995c8b9e');
  assert.equal(PIN.settlement_id, '685fe136-0376-490d-8155-11d6c2fe4844');
  assert.equal(PIN.check_id, 'fd3ad3c0-a764-4f78-9160-ac1eb1699d17');
  assert.ok(PIN.forbidden_claims_unused.some((row) => row.includes('695064-GQ')));
});

test('financial providers stayed disabled and no unexpected ledger activity occurred', () => {
  assert.equal(PIN.financial_operations_disabled, true);
  assert.equal(PIN.unexpected_ledger_or_financial_activity, false);
  assert.equal(PIN.preflight.workflow_status.AWS_PROVIDER_EXECUTION_ENABLED, false);
  assert.equal(PIN.preflight.workflow_status.AWS_CHECKALT_ENABLED, false);
  assert.equal(PIN.preflight.workflow_status.AWS_MOOV_ENABLED, false);
  assert.equal(PIN.preflight.workflow_status.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED, true);
  assert.equal(PIN.preflight.workflow_status.environment, 'staging');
  assert.equal(PIN.counts.before.homeowner_ledger_events, 0);
  assert.equal(PIN.counts.after_insert.homeowner_ledger_events, 0);
  assert.equal(PIN.counts.after_update.homeowner_ledger_events, 0);
  assert.equal(PIN.counts.after_invalid.homeowner_ledger_events, 0);
  assert.equal(PIN.counts.after_cleanup.homeowner_ledger_events, 0);
  assert.equal(PIN.counts.after_cleanup.claim_payments, 0);
  assert.equal(PIN.counts.after_cleanup.deposit_items, 0);
  assert.equal(PIN.counts.after_cleanup.checkalt_deposits, 0);
  assert.equal(PIN.counts.after_cleanup.disbursement_batches, 0);
  assert.equal(PIN.post_run_reconfirm.providers_disabled, true);
  assert.equal(PIN.post_run_reconfirm.homeowner_ledger_events, 0);
});

test('settlement insert/update stayed on one row and rejected invalid payloads', () => {
  assert.equal(PIN.counts.before.claim_settlements, 0);
  assert.equal(PIN.counts.after_insert.claim_settlements, 1);
  assert.equal(PIN.counts.after_update.claim_settlements, 1);
  assert.equal(PIN.counts.after_invalid.claim_settlements, 1);
  assert.equal(PIN.persisted_settlement.after_insert.replacement_cost_value, 15000);
  assert.equal(PIN.persisted_settlement.after_insert.other_structures_rcv, 400);
  assert.equal(PIN.persisted_settlement.after_insert.pwi_rcv, 300);
  assert.equal(PIN.persisted_settlement.after_update.replacement_cost_value, 17500);
  assert.equal(PIN.persisted_settlement.after_update.other_structures_rcv, 400);
  assert.equal(Object.keys(PIN.persisted_settlement.after_insert).length, 17);
  const names = PIN.tests.map((row) => row.name);
  assert.ok(names.includes('invalid invalid_uuid'));
  assert.ok(names.includes('invalid pwi_deductible'));
  assert.ok(names.includes('invalid negative RCV'));
  assert.ok(PIN.tests.every((row) => row.ok === true));
});

test('synthetic check was deleted and labeled claim plus settlement were retained', () => {
  assert.equal(PIN.cleanup.synthetic_check_deleted, true);
  assert.equal(PIN.cleanup.claim_retained, true);
  assert.equal(PIN.cleanup.settlement_retained, true);
  assert.equal(PIN.cleanup.claim_number, 'AWS SETTLEMENT UAT');
  assert.equal(PIN.counts.after_cleanup.check_intake_items, 0);
  assert.equal(PIN.counts.after_cleanup.claims, 1);
  assert.equal(PIN.counts.after_cleanup.claim_settlements, 1);
  assert.equal(PIN.post_run_reconfirm.labeled_claim_count, 1);
  assert.equal(PIN.post_run_reconfirm.settlement_count, 1);
  assert.equal(PIN.post_run_reconfirm.same_settlement_id, true);
  assert.equal(PIN.post_run_reconfirm.synthetic_check_count, 0);
  assert.deepEqual(PIN.mutations, [
    { table: 'check_intake_items', op: 'insert', id: PIN.check_id },
    { table: 'claims', op: 'insert', id: PIN.synthetic_claim_id },
    { table: 'claim_settlements', op: 'insert', id: PIN.settlement_id },
    { table: 'check_intake_items', op: 'delete', id: PIN.check_id },
  ]);
});

test('live RPC and SQL 53 pins still match current source and do not write ledger', () => {
  const rpc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/claim-settlement-rpc.mjs'), 'utf8');
  const data = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const sql = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql'), 'utf8');
  assert.equal(
    sha256File('aws/functions/api/claim-settlement-rpc.mjs'),
    PIN.preflight.live_lambda.claim_settlement_rpc_sha256,
  );
  assert.equal(
    PIN.preflight.live_lambda.claim_settlement_rpc_sha256,
    '4d0b312cadaeffb7bff2d96eea9c4815a1f23815c9c9dcbdbceea4e4d3203d64',
  );
  assert.equal(
    PIN.preflight.sql53.definitionSha256,
    '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52',
  );
  assert.match(data, /earlyName === 'save_claim_settlement_breakdown'/);
  assert.match(rpc, /SELECT public\.save_claim_settlement_breakdown\(\$1::uuid, \$2::uuid, \$3::jsonb\)/);
  assert.doesNotMatch(sql, /homeowner_ledger_events/);
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
});
