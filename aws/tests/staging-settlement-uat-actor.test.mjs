import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-settlement-uat-actor.json'), 'utf8'));
const RPC = fs.readFileSync(path.join(ROOT, 'aws/functions/api/claim-settlement-rpc.mjs'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql'), 'utf8');
const HELPERS = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/20_write_helpers.sql'), 'utf8');
const OWNERS = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/10_owner_helpers_from_identity.sql'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow.mjs'), 'utf8');

test('revised actor plan is evaluate-only GO and does not execute writes', () => {
  assert.equal(PIN.id, 'staging-settlement-uat-actor');
  assert.equal(PIN.verdict, 'GO');
  assert.equal(PIN.execution_verdict, 'NO-GO');
  assert.equal(PIN.write_authorized, false);
  assert.equal(PIN.auth_weakened, false);
  assert.equal(PIN.freedom_admin_eligible, true);
  assert.equal(PIN.actor_requirement, 'historical_fixture');
  assert.deepEqual(PIN.mutations, []);
});

test('settlement authorization is tenant write, not a staff UUID allowlist', () => {
  assert.match(SQL, /public\.aws_can_write_claim\(p_claim_id\)/);
  assert.doesNotMatch(SQL, /abd3c2a0-6dc0-4680-92dd-a013e1141c91/);
  assert.doesNotMatch(RPC, /abd3c2a0-6dc0-4680-92dd-a013e1141c91/);
  assert.match(RPC, /authorizationSource: 'aws_can_write_claim'/);
  assert.match(HELPERS, /has_role\(auth\.uid\(\), 'admin'::public\.app_role\)/);
  assert.match(HELPERS, /has_role\(auth\.uid\(\), 'staff'::public\.app_role\)/);
  assert.match(OWNERS, /no longer recognizes\n-- the legacy Freedom Adjustment application UUID/);
  assert.match(OWNERS, /checksopsadmin@gmail.com/);
  assert.equal(PIN.authorization_rules.no_uuid_allowlist, true);
  assert.equal(PIN.authorization_rules.admin_and_staff_equivalent_for_claim_write, true);
});

test('verified Freedom admin can write Freedom claims and delete the synthetic check', () => {
  assert.equal(PIN.verified_actor.application_user_id, '7dbb3009-f059-4767-b5dc-1c5c72379330');
  assert.equal(PIN.verified_actor.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(PIN.verified_actor.is_master_owner, false);
  assert.equal(PIN.verified_actor.cross_tenant_reader, false);
  assert.match(WORKFLOW, /Only admins can delete checks/);
  assert.ok(PIN.remaining_tests.separately_gated.some((row) => row.includes('C1C')));
  assert.ok(PIN.remaining_tests.optional_deferred.some((row) => row.includes('abd3c2a0')));
  assert.ok(PIN.pre_write_reconfirm.stop_if.includes('isMasterOwner is true'));
});
