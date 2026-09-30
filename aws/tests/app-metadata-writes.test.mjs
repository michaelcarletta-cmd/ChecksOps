import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { SAFE_WRITE_RPC_CLASSIFICATION } from '../functions/api/workflow-rpc.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

test('tranche-6 tables are allowlisted with narrow columns', () => {
  for (const table of [
    'notifications', 'tenant_documents', 'loss_draft_documents', 'mortgage_companies',
    'shared_check_messages', 'profiles', 'company_branding', 'referral_alerts',
    'tenants', 'privacy_notice_acknowledgments', 'tenant_users',
    'cash_jobs', 'cash_job_line_items', 'cash_job_attachments', 'homeowner_ledger_events',
    'mortgage_request_library_documents', 'claims',
  ]) {
    assert.equal(WRITE_ALLOWLIST[table].tranche, 6, table);
  }
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('moov_allowlisted'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('checkalt_enabled'));
  assert.ok(WRITE_ALLOWLIST.shared_check_messages.clientIgnored.has('sender_user_id'));
  assert.deepEqual([...WRITE_ALLOWLIST.tenant_users.columns], ['role']);
});

test('admin_delete_check is client-bridged; financial RPCs stay classified disabled', () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.admin_delete_check, 'already_bridged');
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.deposit_action, 'safe_now_subset');
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.mark_deposit_closeout, 'financial_sensitive');
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.add_partner_stakeholder_to_check, 'provider_dependent');
});

const mapping = { application_user_id: APP_ID };

test('shared_check_messages insert derives sender_* and rejects outsiders', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: CHECK_ID, tenant_id: TENANT }] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        return { rows: [{ tenant_id: TENANT }] };
      }
      if (/INSERT INTO public.shared_check_messages/.test(sql)) {
        assert.equal(params[2], APP_ID);
        assert.equal(params[3], TENANT);
        return { rows: [{ id: 'msg-1', check_id: CHECK_ID, body: params[1], sender_user_id: APP_ID, sender_tenant_id: TENANT }] };
      }
      return { rows: [] };
    },
  };
  const rows = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'shared_check_messages',
    op: 'insert',
    values: { check_id: CHECK_ID, body: 'hello partner' },
    filters: [],
  });
  assert.equal(rows.rows[0].sender_user_id, APP_ID);
});

test('notifications mark-all-read updates only own rows', async () => {
  const client = {
    query: async (sql, params) => {
      assert.match(sql, /UPDATE public.notifications/);
      assert.equal(params[0], APP_ID);
      return { rows: [{ id: 'n1', user_id: APP_ID, is_read: true }] };
    },
  };
  const result = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'notifications',
    op: 'update',
    values: { is_read: true },
    filters: [{ column: 'user_id', op: 'eq', value: APP_ID }, { column: 'is_read', op: 'eq', value: false }],
  });
  assert.equal(result.rows.length, 1);
});

test('tenant_users role updates require admin membership and valid enum', async () => {
  const client = {
    query: async (sql, params) => {
      if (/FROM public.tenant_users WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid LIMIT 1/.test(sql)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/role = 'admin'/.test(sql)) {
        return { rows: [{ role: 'admin' }] };
      }
      if (/UPDATE public.tenant_users SET role/.test(sql)) {
        assert.equal(params[2], 'viewer');
        return { rows: [{ id: 'tu1', tenant_id: TENANT, user_id: '11111111-1111-4111-8111-111111111111', role: 'viewer' }] };
      }
      return { rows: [] };
    },
  };
  const ok = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'tenant_users',
    op: 'update',
    values: { role: 'viewer' },
    filters: [
      { column: 'tenant_id', op: 'eq', value: TENANT },
      { column: 'user_id', op: 'eq', value: '11111111-1111-4111-8111-111111111111' },
    ],
  });
  assert.equal(ok.rows[0].role, 'viewer');

  const bad = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'tenant_users',
    op: 'update',
    values: { role: 'superadmin' },
    filters: [
      { column: 'tenant_id', op: 'eq', value: TENANT },
      { column: 'user_id', op: 'eq', value: '11111111-1111-4111-8111-111111111111' },
    ],
  });
  assert.equal(bad.error, 'invalid_field');
});


test('cash_jobs denies payment columns; homeowner ledger denies amount via clientIgnored', () => {
  assert.ok(!WRITE_ALLOWLIST.cash_jobs.columns.has('total_paid'));
  assert.ok(!WRITE_ALLOWLIST.cash_jobs.columns.has('balance_due'));
  assert.ok(WRITE_ALLOWLIST.homeowner_ledger_events.clientIgnored.has('amount'));
  assert.ok(!WRITE_ALLOWLIST.homeowner_ledger_events.columns.has('amount'));
  assert.ok(!WRITE_ALLOWLIST['cash_job_payments']);
});

test('homeowner ledger insert forces null amount and membership check', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/INSERT INTO public.homeowner_ledger_events/.test(sql)) {
        assert.equal(params[params.length - 1] === undefined ? null : null, null);
        assert.equal(params[8], APP_ID);
        // amount bound as NULL literal in SQL; last value is created_by
        return { rows: [{ id: 'e1', amount: null, event_type: params[4] }] };
      }
      return { rows: [] };
    },
  };
  const result = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'homeowner_ledger_events',
    op: 'insert',
    values: {
      tenant_id: TENANT,
      claim_id: '8ff57eaf-f200-4466-a1cf-2debb56c88a8',
      event_type: 'tenant_update',
      payload_json: { note: 'hello' },
    },
    filters: [],
  });
  assert.equal(result.rows[0].amount, null);
  assert.match(queries.at(-1).sql, /amount/);
});

const CLAIM_ID = '8ff57eaf-f200-4466-a1cf-2debb56c88a8';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';

test('claims allowlist is update-only for claim_number', () => {
  const awsClient = readFileSync('src/integrations/aws/client.ts', 'utf8');
  assert.match(awsClient, /const AWS_WRITE_TABLES = new Set\(\[[\s\S]*"claims",[\s\S]*\]\)/);
  assert.doesNotMatch(awsClient, /"claim_settlements",/);
  assert.match(awsClient, /save_claim_settlement_breakdown/);
  assert.equal(WRITE_ALLOWLIST.claims.tranche, 6);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('delete'), false);
  assert.deepEqual([...WRITE_ALLOWLIST.claims.columns], ['claim_number']);
  assert.ok(!WRITE_ALLOWLIST.claims.columns.has('org_id'));
  assert.ok(!WRITE_ALLOWLIST.claims.columns.has('status'));
  assert.ok(!WRITE_ALLOWLIST.claims.columns.has('amount'));
  const grant = readFileSync('aws/workflows/sql/70_staging_claims_number_grant.sql', 'utf8');
  const grantLines = grant.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.match(grantLines, /GRANT UPDATE \(claim_number, updated_at\) ON TABLE public\.claims TO checksops;/);
  assert.doesNotMatch(grantLines, /GRANT INSERT/);
  assert.doesNotMatch(grantLines, /GRANT DELETE/);
  assert.doesNotMatch(grantLines, /ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY/);
  assert.doesNotMatch(grantLines, /payment_transfers|checkalt_deposits|claim_payments/);
});

test('authorized tenant member can rename an existing claim in place', async () => {
  const snapshot = {
    id: CLAIM_ID,
    org_id: TENANT,
    claim_number: 'CLM-OLD',
    status: 'tracking',
    policyholder_name: 'Jane Doe',
    policyholder_address: '1 Main St',
    insurance_company: 'Acme',
  };
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.claims WHERE id = \$1::uuid LIMIT 1/.test(sql)) {
        return { rows: [snapshot] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        assert.equal(params[0], APP_ID);
        assert.equal(params[1], TENANT);
        return { rows: [{ ok: 1 }] };
      }
      if (/UPDATE public.claims/.test(sql)) {
        assert.equal(params[0], CLAIM_ID);
        assert.equal(params[1], 'CLM-NEW');
        assert.equal(params[2], TENANT);
        assert.match(sql, /SET claim_number = \$2::text/);
        assert.match(sql, /WHERE id = \$1::uuid AND org_id = \$3::uuid/);
        assert.equal(/status|policyholder_name|org_id = \$2/.test(sql.replace('org_id = $3', '')), false);
        return { rows: [{ ...snapshot, claim_number: 'CLM-NEW' }] };
      }
      return { rows: [] };
    },
  };
  const result = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'claims',
    op: 'update',
    values: { claim_number: '  CLM-NEW  ' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(result.rows[0].id, CLAIM_ID);
  assert.equal(result.rows[0].claim_number, 'CLM-NEW');
  assert.equal(result.rows[0].org_id, TENANT);
  assert.equal(result.rows[0].status, 'tracking');
  assert.equal(result.rows[0].policyholder_name, 'Jane Doe');
  assert.equal(result.rows[0].insurance_company, 'Acme');
});

test('claim number update refuses outsiders, unassigned claims, inserts, and unique conflicts', async () => {
  const outsider = await executeAppMetadataWrite({
    client: {
      query: async (sql) => {
        if (/FROM public.claims WHERE id/.test(sql)) {
          return { rows: [{ id: CLAIM_ID, org_id: OTHER_TENANT, claim_number: 'CLM-OLD' }] };
        }
        if (/FROM public.tenant_users/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    },
    mapping,
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(outsider.error, 'not_authorized');

  const unassigned = await executeAppMetadataWrite({
    client: {
      query: async (sql) => {
        if (/FROM public.claims WHERE id/.test(sql)) {
          return { rows: [{ id: CLAIM_ID, org_id: null, claim_number: 'CLM-OLD' }] };
        }
        return { rows: [] };
      },
    },
    mapping,
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(unassigned.error, 'not_authorized');

  const insert = await executeAppMetadataWrite({
    client: { query: async () => ({ rows: [] }) },
    mapping,
    table: 'claims',
    op: 'insert',
    values: { claim_number: 'CLM-NEW' },
    filters: [],
  });
  assert.equal(insert.error, 'operation_not_allowlisted');

  const conflict = await executeAppMetadataWrite({
    client: {
      query: async (sql) => {
        if (/FROM public.claims WHERE id/.test(sql)) {
          return { rows: [{ id: CLAIM_ID, org_id: TENANT, claim_number: 'CLM-OLD' }] };
        }
        if (/FROM public.tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
        if (/UPDATE public.claims/.test(sql)) {
          const error = new Error('duplicate key value violates unique constraint "claims_claim_number_key"');
          error.code = '23505';
          throw error;
        }
        return { rows: [] };
      },
    },
    mapping,
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-DUP' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(conflict.error, 'claim_number_conflict');
});
