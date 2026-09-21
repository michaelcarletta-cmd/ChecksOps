import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import {
  executeAppMetadataWrite,
  executeTenantsNarrow,
} from '../functions/api/write-app-metadata.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { tenantFeeCharge } from '../functions/api/providers/parity/moov-money.mjs';
import { transferPostEnabled } from '../functions/api/providers/parity/caller.mjs';
import { runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
import { readTenantCheckUsage } from '../functions/api/data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP_ID = '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const CONTRACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILLING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAKE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const clientOf = ({
  platformOwner = false,
  memberships = [],
  roles = [],
  updates = [],
} = {}) => ({
  query: async (sql, params = []) => {
    if (sql.includes('is_platform_owner()')) {
      return { rows: [{ is_owner: platformOwner }] };
    }
    if (sql.includes('is_master_owner()')) {
      return { rows: [{ is_master: platformOwner }] };
    }
    if (sql.includes('FROM public.user_roles')) {
      return { rows: roles.map((role) => ({ role })) };
    }
    if (sql.includes('FROM public.tenant_users') && sql.includes('LIMIT 1')) {
      const tenantId = params[1] || params[0];
      const hit = memberships.some((m) => m.tenant_id === tenantId);
      const role = memberships.find((m) => m.tenant_id === tenantId)?.role || 'admin';
      return { rows: hit ? [{ role, '?column?': 1 }] : [] };
    }
    if (sql.includes('UPDATE public.tenants') || sql.includes('INSERT INTO public.tenants')) {
      updates.push({ table: 'tenants', sql, params });
      return { rows: [{ id: params.at(-1) || PIPELINE }] };
    }
    if (sql.includes('tenant_billing_accounts')) {
      if (sql.includes('INSERT')) {
        updates.push({ table: 'tenant_billing_accounts', op: 'insert', sql, params });
        return { rows: [{ id: BILLING, tenant_id: params[0], stakeholder_account_id: params[1] }] };
      }
      if (sql.includes('UPDATE')) {
        updates.push({ table: 'tenant_billing_accounts', op: 'update', sql, params });
        return { rows: [{ id: BILLING, tenant_id: PIPELINE }] };
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.platform_announcements')) {
      updates.push({ table: 'platform_announcements', op: 'insert', sql, params });
      return { rows: [{ id: BILLING, title: params[0] }] };
    }
    if (sql.includes('INSERT INTO public.glba_security_events')) {
      updates.push({ table: 'glba_security_events', op: 'insert', sql, params });
      return { rows: [{ id: BILLING, event_type: params[1] }] };
    }
    if (sql.includes('UPDATE public.contractor_profiles')) {
      updates.push({ table: 'contractor_profiles', sql, params });
      return { rows: [{ id: CONTRACTOR }] };
    }
    if (sql.includes('contractor_verification_status')) {
      return { rows: [{ found: true, current_tier: 'pro' }] };
    }
    if (sql.includes('INSERT INTO public.tenant_users')) {
      updates.push({ table: 'tenant_users', sql, params });
      return { rows: [{ id: BILLING }] };
    }
    if (sql.includes('INSERT INTO public.identity_accounts') || sql.includes('INSERT INTO public.profiles')) {
      return { rows: [{ id: APP_ID }] };
    }
    if (sql.includes('FROM public.profiles')) {
      return { rows: [] };
    }
    if (sql.includes('FROM public.tenants')) {
      return { rows: [{ id: PIPELINE, slug: 'pipeline-test-68d1b910', name: 'Pipeline Test', custom_domain: null }] };
    }
    return { rows: [] };
  },
});

test('TM command-center allowlist restores Lovable tenant columns and denies provider flags', () => {
  for (const col of [
    'per_check_billing_enabled', 'per_check_rate_cents',
    'referral_code', 'referral_discount_cents', 'partner_code', 'referred_by_tenant_id',
    'legal_business_name', 'ein', 'business_address', 'business_phone',
    'beneficial_owner_name', 'beneficial_owner_dob', 'kyc_completed_at',
  ]) {
    assert.ok(WRITE_ALLOWLIST.tenants.columns.has(col), col);
  }
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('moov_allowlisted'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('checkalt_enabled'));
  assert.ok(!WRITE_ALLOWLIST.tenants.columns.has('actum_password'));
  assert.equal(WRITE_ALLOWLIST.tenant_billing_accounts.tranche, 6);
  assert.equal(WRITE_ALLOWLIST.platform_announcements.tranche, 6);
  assert.equal(WRITE_ALLOWLIST.glba_security_events.tranche, 6);
  assert.ok(!WRITE_ALLOWLIST.tenant_billing_accounts.columns.has('account_number_encrypted'));
  assert.ok(!WRITE_ALLOWLIST.tenant_billing_accounts.columns.has('routing_number'));
});

test('frontend write table set includes TM command-center tables', () => {
  const src = read('src/integrations/aws/client.ts');
  assert.match(src, /tenant_billing_accounts/);
  assert.match(src, /platform_announcements/);
  assert.match(src, /glba_security_events/);
});

test('platform owner can save pricing, referral, and compliance on the tenant row', async () => {
  const updates = [];
  const result = await executeTenantsNarrow({
    client: clientOf({ platformOwner: true, memberships: [], updates }),
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: {
      monthly_rate_cents: 10000,
      per_check_billing_enabled: true,
      per_check_rate_cents: 400,
      referral_code: 'checks9636',
      referral_discount_cents: 2500,
      partner_code: 'b3136bc9',
      legal_business_name: 'Pipeline Test LLC',
      ein: '12-3456789',
      kyc_completed_at: '2026-09-21T00:00:00Z',
      kyc_completed_by: 'should-be-replaced',
    },
    filters: [{ column: 'id', op: 'eq', value: PIPELINE }],
  });
  assert.equal(result.error, undefined);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /per_check_billing_enabled/);
  assert.match(updates[0].sql, /referral_code/);
  assert.match(updates[0].sql, /legal_business_name/);
  assert.ok(updates[0].params.includes('CHECKS9636'));
  assert.ok(updates[0].params.includes(APP_ID));
});

test('tenant member cannot write pricing or referral columns', async () => {
  const denied = await executeTenantsNarrow({
    client: clientOf({
      platformOwner: false,
      memberships: [{ tenant_id: FREEDOM }],
    }),
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: { referral_code: 'HACK', monthly_rate_cents: 1 },
    filters: [{ column: 'id', op: 'eq', value: FREEDOM }],
  });
  assert.equal(denied.error, 'missing_required_field');
});

test('platform owner can link a billing bank without membership', async () => {
  const updates = [];
  const result = await executeAppMetadataWrite({
    client: clientOf({ platformOwner: true, memberships: [], updates }),
    mapping: { application_user_id: APP_ID },
    table: 'tenant_billing_accounts',
    op: 'insert',
    values: {
      tenant_id: PIPELINE,
      stakeholder_account_id: STAKE,
      auto_debit_enabled: true,
      ach_authorized_at: '2026-09-21T00:00:00Z',
    },
    filters: [],
  });
  assert.equal(result.error, undefined);
  assert.equal(updates[0].table, 'tenant_billing_accounts');
  assert.equal(updates[0].op, 'insert');
});

test('non-owner cannot write another tenant billing account', async () => {
  const result = await executeAppMetadataWrite({
    client: clientOf({ platformOwner: false, memberships: [] }),
    mapping: { application_user_id: APP_ID },
    table: 'tenant_billing_accounts',
    op: 'insert',
    values: { tenant_id: PIPELINE, stakeholder_account_id: STAKE },
    filters: [],
  });
  assert.equal(result.error, 'not_authorized');
});

test('platform owner can publish announcements and record KYC events', async () => {
  const updates = [];
  const client = clientOf({ platformOwner: true, memberships: [], updates });
  const announced = await executeAppMetadataWrite({
    client,
    mapping: { application_user_id: APP_ID },
    table: 'platform_announcements',
    op: 'insert',
    values: { title: 'Update', message: 'Staging notice', severity: 'info' },
    filters: [],
  });
  assert.equal(announced.error, undefined);
  const glba = await executeAppMetadataWrite({
    client,
    mapping: { application_user_id: APP_ID },
    table: 'glba_security_events',
    op: 'insert',
    values: { tenant_id: PIPELINE, event_type: 'kyc.completed', metadata: { ein_last_4: '6789' } },
    filters: [],
  });
  assert.equal(glba.error, undefined);
  assert.equal(updates.some((u) => u.table === 'platform_announcements'), true);
  assert.equal(updates.some((u) => u.table === 'glba_security_events'), true);
});

test('platform owner can upload branding without tenant_users membership', async () => {
  const allowed = await authorizeStorageWritePath(
    clientOf({ platformOwner: true, memberships: [] }),
    'tenant-logos',
    `${PIPELINE}/logo.png`,
    APP_ID,
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.strategy, 'branding');

  const denied = await authorizeStorageWritePath(
    clientOf({ platformOwner: false, memberships: [] }),
    'tenant-logos',
    `${PIPELINE}/logo.png`,
    APP_ID,
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'rls_denied');
});

test('platform owner can approve OPS badge without user_roles', async () => {
  const updates = [];
  const result = await executeSafeWriteRpc({
    client: clientOf({ platformOwner: true, memberships: [], roles: [], updates }),
    mapping: { application_user_id: APP_ID },
    name: 'admin_set_contractor_pro',
    args: { p_contractor_id: CONTRACTOR, p_approve: true },
  });
  assert.equal(result.error, undefined);
  assert.equal(updates.some((u) => u.table === 'contractor_profiles'), true);

  const denied = await executeSafeWriteRpc({
    client: clientOf({ platformOwner: false, memberships: [], roles: [] }),
    mapping: { application_user_id: APP_ID },
    name: 'admin_set_contractor_pro',
    args: { p_contractor_id: CONTRACTOR, p_approve: true },
  });
  assert.equal(denied.error, 'not_authorized');
});

test('monthly collection stays dark unless transfer POST is enabled', async () => {
  delete process.env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED;
  delete process.env.AWS_MOOV_TRANSFER_POST_ENABLED;
  assert.equal(transferPostEnabled(), false);
  const result = await tenantFeeCharge.run({
    client: clientOf({ platformOwner: true }),
    mapping: { application_user_id: APP_ID },
    body: { tenant_id: PIPELINE, amount_cents: 10000, kind: 'maintenance', line_items: [] },
    ctx: { tenantId: PIPELINE },
    fetchImpl: async () => {
      throw new Error('Moov POST must not run in dark collection');
    },
  });
  assert.equal(result.dark, true);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.results[0].status, 'preview');
  assert.equal(result.results[0].amount_cents, 10000);
});

test('invite reports invite_sent honestly and coerces member role to viewer', async () => {
  const sent = [];
  const result = await runTenantInviteUser({
    mapping: { application_user_id: APP_ID },
    spoof: { ignored: true },
    send: async (payload) => { sent.push(payload); return { sunkCount: 1 }; },
    body: { tenant_id: PIPELINE, email: 'user@example.com', role: 'member' },
    cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: APP_ID }] } }),
    client: clientOf({ platformOwner: true, memberships: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.invite_sent, true);
  assert.equal(result.role, 'viewer');
  assert.equal(sent.length, 1);

  const failed = await runTenantInviteUser({
    mapping: { application_user_id: APP_ID },
    spoof: { ignored: true },
    send: async () => { throw new Error('sink refused'); },
    body: { tenant_id: PIPELINE, email: 'user@example.com', role: 'admin' },
    cognitoJson: async () => ({ User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: APP_ID }] } }),
    client: clientOf({ platformOwner: true, memberships: [] }),
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.invite_sent, false);
  assert.match(String(failed.invite_error), /sink refused/);
});

test('platform-owner usage reader uses existing billing event tables', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM public.check_billing_events') && sql.includes('COUNT')) {
        return { rows: [{ count: 2, amount_cents: 800 }] };
      }
      if (sql.includes('FROM public.mortgage_handling_requests') && sql.includes('COUNT')) {
        return { rows: [{ count: 1, amount_cents: 1000, shipping_cents: 0 }] };
      }
      return { rows: [{ item: { event_type: 'check_processing', unit_price_cents: 400 } }] };
    },
  };
  const data = await readTenantCheckUsage(client, {
    tenantId: FREEDOM,
    monthStart: '2026-09-01T00:00:00Z',
    monthEnd: '2026-10-01T00:00:00Z',
  });
  assert.equal(data.count, 3);
  assert.equal(data.amount_cents, 1800);
  assert.equal(data.mortgage_count, 1);
  assert.equal(data.currency, 'usd');
  assert.ok(queries.some((q) => q.sql.includes('check_billing_events')));
  assert.ok(queries.some((q) => q.sql.includes('mortgage_handling_requests')));
});

test('TM UI uses env-aware KYC, invite resend, and dark collection copy', () => {
  const admin = read('src/pages/admin/AdminTenants.tsx');
  assert.match(admin, /Never pick the newest row across environments/);
  assert.match(admin, /t\.moov_environment/);
  assert.match(admin, /tenant-invite-user/);
  assert.doesNotMatch(admin, /resetPasswordForEmail/);
  assert.match(admin, /invite_sent === false/);
  assert.match(admin, /Preview only/);
  assert.match(admin, /ACH was not submitted/);
  assert.match(admin, /referral_discount_cents/);
  assert.match(admin, /partner_code: partnerCode/);
  assert.match(admin, /useState\("viewer"\)/);
  assert.match(read('src/integrations/aws/client.ts'), /tenant_billing_accounts/);
});
