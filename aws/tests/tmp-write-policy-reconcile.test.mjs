import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AFTER_REPAIR_POLICIES,
  COLLECTION_V2_CREATE_OR_GET_OCCURRENCE_INSERT,
  COLLECTION_V2_SETTLEMENT_UPDATE,
  INSPECTED_CATALOG,
  LIVE_POLICIES,
  REMAINING_POLICY_NAMES,
  actorMatrix,
  evaluateAwsCanWriteTenant,
  naiveReplaceRemovesMachineWrite,
} from '../rls/tmp-write-policy-reconcile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/39_tmp_write_policy_reconcile.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/39_tmp_write_policy_reconcile_rollback.sql'), 'utf8');
const HELPER = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/20_write_helpers.sql'), 'utf8');
const INTENDED = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/24_complete_write_policies.sql'), 'utf8');

const expectedAfter = {
  authorized_tenant_admin_insert: true,
  unauthorized_tenant_insert: false,
  authorized_tenant_update: true,
  cross_tenant_update: false,
  ordinary_user_foreign_insert: false,
  monthly_billing_job: true,
  provider_webhook_apply: true,
  platform_owner_insert: true,
  public_role_insert: false,
  anon_insert: false,
  collection_v2_create_or_get_occurrence: true,
  collection_v2_settlement_update: true,
};

const expectedBefore = {
  ...expectedAfter,
  authorized_tenant_admin_insert: false,
  authorized_tenant_update: false,
  collection_v2_create_or_get_occurrence: false,
  collection_v2_settlement_update: false,
};

const statementsOf = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('SQL 39 is the smallest AWS TMP write reconcile and does not touch helpers/grants/RLS', () => {
  const applyBody = statementsOf(APPLY);
  assert.match(APPLY, /SOURCE \/ TEST ONLY/);
  assert.match(APPLY, /Not a Supabase migration/);
  assert.match(applyBody, /aws_can_write_tenant\(tenant_id\)/);
  assert.match(applyBody, /TMP_JOB_POLICY_MISSING/);
  assert.match(applyBody, /TMP_WRITE_POLICY_COLLISION/);
  assert.match(applyBody, /aws_write_tenant_maintenance_payments_job/);
  assert.match(INTENDED, /aws_can_write_tenant\(tenant_id\)/);
  assert.match(HELPER, /CREATE OR REPLACE FUNCTION public\.aws_can_write_tenant/);
  assert.doesNotMatch(applyBody, /CREATE OR REPLACE FUNCTION public\.aws_can_write_tenant/);
  assert.doesNotMatch(applyBody, /DISABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(applyBody, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(applyBody, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(applyBody, /\bGRANT\b/);
  assert.doesNotMatch(applyBody, /\bREVOKE\b/);
  assert.doesNotMatch(applyBody, /DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments_job/);
  assert.doesNotMatch(applyBody, /DROP POLICY IF EXISTS aws_select_tenant_maintenance_payments/);
  assert.match(APPLY, /Not a Supabase migration/);
  assert.doesNotMatch(applyBody, /service_role/);
  assert.doesNotMatch(applyBody, /from\(['"]tenant_maintenance_payments['"]\)/);
  assert.doesNotMatch(ROLLBACK, /pg_dump|restore database/i);
  assert.match(ROLLBACK, /Does not restore a database snapshot/);
});

test('live catalog vs intended: only the authenticated write predicate is drifted', () => {
  assert.equal(LIVE_POLICIES.length, 4);
  assert.deepEqual(LIVE_POLICIES.map((p) => p.name).sort(), [...REMAINING_POLICY_NAMES].sort());
  assert.equal(LIVE_POLICIES.filter((p) => p.permissive === 'RESTRICTIVE').length, 0);
  const liveWrite = LIVE_POLICIES.find((p) => p.name === 'aws_write_tenant_maintenance_payments');
  assert.equal(liveWrite.using.includes('aws_can_write_tenant'), false);
  assert.equal(liveWrite.using.includes('is_platform_owner()'), true);
  const afterWrite = AFTER_REPAIR_POLICIES.find((p) => p.name === 'aws_write_tenant_maintenance_payments');
  assert.equal(afterWrite.using, INSPECTED_CATALOG.intendedWriteUsing);
  const job = AFTER_REPAIR_POLICIES.find((p) => p.name === 'aws_write_tenant_maintenance_payments_job');
  assert.equal(job.using, INSPECTED_CATALOG.jobUsing);
  assert.equal(job.roles[0], 'checksops');
});

test('required authorization matrix before and after repair', () => {
  const before = Object.fromEntries(actorMatrix(LIVE_POLICIES).map((row) => [row.name, row.allowed]));
  const after = Object.fromEntries(actorMatrix(AFTER_REPAIR_POLICIES).map((row) => [row.name, row.allowed]));
  assert.deepEqual(before, expectedBefore);
  assert.deepEqual(after, expectedAfter);
});

test('dropping the job policy while using only aws_can_write_tenant would remove machine-write', () => {
  const withoutJob = AFTER_REPAIR_POLICIES.filter((p) => p.name !== 'aws_write_tenant_maintenance_payments_job');
  assert.equal(naiveReplaceRemovesMachineWrite(withoutJob), true);
  assert.equal(
    actorMatrix(AFTER_REPAIR_POLICIES).find((row) => row.name === 'monthly_billing_job').allowed,
    true,
  );
});

test('aws_can_write_tenant contract is unchanged and still denies ninth-UUID style writes', () => {
  const T1 = 'db13cc17-547b-4ca8-806a-f3cf79eafe59';
  assert.equal(evaluateAwsCanWriteTenant({ uid: 'u', tenantIds: [T1], hasAdmin: true }, T1), true);
  assert.equal(evaluateAwsCanWriteTenant({ uid: 'u', tenantIds: [T1], hasAdmin: true }, 'other'), false);
  assert.equal(evaluateAwsCanWriteTenant({ uid: 'u', tenantIds: [], hasAdmin: true }, T1), false);
  assert.equal(evaluateAwsCanWriteTenant({ tenantIds: [T1], hasAdmin: true }, T1), false);
  assert.equal(evaluateAwsCanWriteTenant({ uid: 'u', isPlatformOwner: true, tenantIds: [] }, T1), true);
});

test('Collection V2 create/settlement SQL has no machine-write GUC and therefore needs the repaired policy', () => {
  assert.match(COLLECTION_V2_CREATE_OR_GET_OCCURRENCE_INSERT, /INSERT INTO public\.tenant_maintenance_payments/);
  assert.match(COLLECTION_V2_SETTLEMENT_UPDATE, /UPDATE public\.tenant_maintenance_payments/);
  assert.doesNotMatch(COLLECTION_V2_CREATE_OR_GET_OCCURRENCE_INSERT, /monthly_billing_job|provider_webhook_apply/);
  assert.doesNotMatch(COLLECTION_V2_SETTLEMENT_UPDATE, /monthly_billing_job|provider_webhook_apply/);
  const create = actorMatrix(AFTER_REPAIR_POLICIES).find((row) => row.name === 'collection_v2_create_or_get_occurrence');
  const settle = actorMatrix(AFTER_REPAIR_POLICIES).find((row) => row.name === 'collection_v2_settlement_update');
  assert.equal(create.allowed, true);
  assert.equal(settle.allowed, true);
  assert.equal(actorMatrix(LIVE_POLICIES).find((row) => row.name === 'collection_v2_create_or_get_occurrence').allowed, false);
});

test('no public/anon financial write policy remains after repair', () => {
  for (const policy of AFTER_REPAIR_POLICIES) {
    assert.equal(policy.roles.includes('PUBLIC'), false);
    assert.equal(policy.roles.includes('anon'), false);
    assert.equal(policy.roles.includes('public'), false);
  }
  assert.deepEqual(INSPECTED_CATALOG.grants.PUBLIC, []);
  assert.deepEqual(INSPECTED_CATALOG.grants.anon, []);
});
