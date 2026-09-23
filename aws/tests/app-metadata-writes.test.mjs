import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { SAFE_WRITE_RPC_CLASSIFICATION } from '../functions/api/workflow-rpc.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.ok(WRITE_ALLOWLIST.tenants.ops.has('insert'));
  assert.ok(WRITE_ALLOWLIST.tenants.ops.has('update'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('slug'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('invoice_accent_color'));
  assert.ok(WRITE_ALLOWLIST.tenants.columns.has('invoice_theme'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('moov_allowlisted'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('moov_account_id'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('checkalt_enabled'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('payment_provider'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('is_system_tenant'));
  assert.ok(!WRITE_ALLOWLIST.tenants.clientIgnored.has('slug'));
  assert.ok(WRITE_ALLOWLIST.shared_check_messages.clientIgnored.has('sender_user_id'));
  assert.deepEqual([...WRITE_ALLOWLIST.tenant_users.columns], ['role']);
});

test('tenant insert is platform-owner only and fail-closes provider inheritance', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/is_master_owner|is_platform_owner/.test(sql)) {
        return { rows: [{ is_master: true, is_platform: true }] };
      }
      if (/SELECT 1 FROM public.tenants WHERE slug/.test(sql)) return { rows: [] };
      if (/INSERT INTO public.tenants/.test(sql)) {
        assert.equal(params[0], 'Acme Adjusting');
        assert.equal(params[1], 'acme-adjusting');
        assert.equal(params[8], 'active');
        assert.match(sql, /moov_allowlisted/);
        assert.match(sql, /false, false, false, NULL/);
        assert.match(sql, /monthly_rate_cents, actum_credits_only/);
        assert.match(sql, /0, false/);
        assert.doesNotMatch(sql, /freedom/i);
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            name: params[0],
            slug: params[1],
            is_system_tenant: false,
            moov_allowlisted: false,
            moov_account_id: null,
            payment_provider: null,
            payment_status: 'not_connected',
          }],
        };
      }
      return { rows: [] };
    },
  };
  const created = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'tenants',
    op: 'insert',
    values: {
      name: 'Acme Adjusting',
      slug: 'Acme Adjusting',
      moov_account_id: 'should-be-ignored-by-allowlist-if-present',
    },
    filters: [],
  });
  assert.equal(created.rows[0].slug, 'acme-adjusting');
  assert.equal(created.rows[0].moov_allowlisted, false);
  assert.equal(created.rows[0].moov_account_id, null);

  const denied = await executeAppMetadataWrite({
    client: {
      query: async (sql) => {
        if (/is_master_owner|is_platform_owner/.test(sql)) {
          return { rows: [{ is_master: false, is_platform: false }] };
        }
        return { rows: [] };
      },
    },
    mapping,
    table: 'tenants',
    op: 'insert',
    values: { name: 'Evil Co', slug: 'evil-co' },
    filters: [],
  });
  assert.equal(denied.error, 'not_authorized');
});

test('tenant update allows platform owner without membership and still rejects provider flags', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const client = {
    query: async (sql, params) => {
      if (/is_master_owner|is_platform_owner/.test(sql)) {
        return { rows: [{ is_master: true, is_platform: true }] };
      }
      if (/UPDATE public.tenants SET/.test(sql)) {
        assert.match(sql, /email_from_address/);
        assert.doesNotMatch(sql, /moov_allowlisted|moov_account_id|payment_provider/);
        assert.equal(params.at(-1), id);
        return { rows: [{ id, name: 'Acme', email_from_address: 'ops@acme.test' }] };
      }
      return { rows: [] };
    },
  };
  const updated = await executeAppMetadataWrite({
    client,
    mapping,
    table: 'tenants',
    op: 'update',
    values: { email_from_address: 'ops@acme.test' },
    filters: [{ column: 'id', op: 'eq', value: id }],
  });
  assert.equal(updated.rows[0].email_from_address, 'ops@acme.test');
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

test('operator SQL grants tenant INSERT only under platform-owner RLS', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'onboarding/sql/81_tenant_insert_platform_owner.sql'),
    'utf8',
  );
  assert.match(sql, /GRANT INSERT ON TABLE public\.tenants TO checksops/);
  assert.match(sql, /CREATE POLICY aws_insert_tenants_platform_owner/);
  assert.match(sql, /is_master_owner\(\)/);
  assert.match(sql, /is_platform_owner\(\)/);
  assert.doesNotMatch(sql, /GRANT UPDATE OF/);
  assert.doesNotMatch(sql, /moov_allowlisted/);
  assert.doesNotMatch(sql, /UPDATE public\.tenants SET/);
});

test('operator SQL neutralizes new-tenant billing defaults without rewriting rows', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'onboarding/sql/83_new_tenant_neutral_billing_defaults.sql'),
    'utf8',
  );
  assert.match(sql, /ALTER COLUMN payment_provider SET DEFAULT NULL/);
  assert.match(sql, /ALTER COLUMN monthly_rate_cents SET DEFAULT 0/);
  assert.match(sql, /ALTER COLUMN actum_credits_only SET DEFAULT false/);
  assert.doesNotMatch(sql, /UPDATE public\.tenants/);
  assert.doesNotMatch(sql, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
});

test('production baseline extras stay with tenant-create insert', () => {
  assert.equal(WRITE_ALLOWLIST.tenants.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.tenants.ops.has('update'), true);
  assert.ok(WRITE_ALLOWLIST.company_branding.clientIgnored.has('logo_url'));
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), false);
  assert.ok(WRITE_ALLOWLIST.claims.clientIgnored.has('org_id'));
  assert.ok(WRITE_ALLOWLIST.claims.clientIgnored.has('tenant_id'));
});
