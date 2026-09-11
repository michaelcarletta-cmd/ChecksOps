import assert from 'node:assert/strict';
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
    'mortgage_request_library_documents',
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
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.deposit_action, 'financial_sensitive');
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
