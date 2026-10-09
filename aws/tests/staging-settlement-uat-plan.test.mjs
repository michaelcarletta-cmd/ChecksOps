import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-settlement-uat-plan.json'), 'utf8'));

function sha256File(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

test('UAT plan is evaluate-only GO and does not authorize writes', () => {
  assert.equal(PIN.id, 'staging-settlement-uat-plan');
  assert.equal(PIN.verdict, 'GO');
  assert.equal(PIN.execution_verdict, 'NO-GO');
  assert.equal(PIN.write_authorized, false);
  assert.equal(PIN.create_claim_authorized, false);
  assert.equal(PIN.save_settlement_authorized, false);
  assert.equal(PIN.existing_synthetic_claim_id, null);
  assert.equal(PIN.reserved_claim_number, 'AWS SETTLEMENT UAT');
  assert.equal(PIN.live_claim_inventory.unauthenticated.httpStatus, 401);
});

test('generic claims insert is not an approved create path', () => {
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  assert.equal(PIN.create_plan.step_3_create_claim.body.name, 'claim_ledger_link_or_create');
  assert.equal(PIN.create_plan.step_3_create_claim.body.args.p_action, 'create_new');
  assert.equal(PIN.create_plan.step_3_create_claim.body.args.p_claim_number, 'AWS SETTLEMENT UAT');
  assert.equal(PIN.create_plan.step_2_create_unlinked_check.expected.claim_id, null);
});

test('settlement write path is the dedicated RPC and matches current source', () => {
  const rpc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/claim-settlement-rpc.mjs'), 'utf8');
  const data = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const sql = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql'), 'utf8');
  assert.equal(PIN.write_mechanism.settlement.name, 'save_claim_settlement_breakdown');
  assert.match(data, /earlyName === 'save_claim_settlement_breakdown'/);
  assert.match(rpc, /SELECT public\.save_claim_settlement_breakdown\(\$1::uuid, \$2::uuid, \$3::jsonb\)/);
  assert.doesNotMatch(sql, /homeowner_ledger_events/);
  assert.equal(
    sha256File('aws/functions/api/claim-settlement-rpc.mjs'),
    '4d0b312cadaeffb7bff2d96eea9c4815a1f23815c9c9dcbdbceea4e4d3203d64',
  );
  assert.deepEqual(Object.keys(PIN.payloads.insert.args.p_values), [
    'replacement_cost_value',
    'recoverable_depreciation',
    'non_recoverable_depreciation',
    'deductible',
    'other_structures_rcv',
    'other_structures_recoverable_depreciation',
    'other_structures_non_recoverable_depreciation',
    'other_structures_deductible',
    'pwi_rcv',
    'pwi_recoverable_depreciation',
    'pwi_non_recoverable_depreciation',
    'personal_property_rcv',
    'personal_property_recoverable_depreciation',
    'personal_property_non_recoverable_depreciation',
    'ale_rcv',
    'ale_recoverable_depreciation',
    'ale_non_recoverable_depreciation',
  ]);
  assert.equal(PIN.expected_writes.homeowner_ledger_events.count_for_claim, 0);
  assert.equal(PIN.expected_writes.provider_transactions, 0);
});

test('actor and cross-tenant pins match accepted Freedom/C1C identities', () => {
  assert.equal(PIN.identities.actor.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(PIN.identities.actor.application_user_id, 'abd3c2a0-6dc0-4680-92dd-a013e1141c91');
  assert.equal(PIN.identities.cross_tenant.tenant_id, '4f172140-f57a-4744-8050-95f4f07b13b4');
  assert.equal(PIN.identities.cross_tenant.expected_on_freedom_claim.error, 'not_authorized');
  assert.ok(PIN.forbidden_claims.some((row) => row.includes('695064-GQ')));
  assert.ok(PIN.cleanup.do_not.includes('apply SQL 44, 20261007193200, or one-writer'));
});
