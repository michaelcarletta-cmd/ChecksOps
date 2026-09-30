import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  BILLING_ACH_CONSENT_VERSION,
  TENANT_BRANDING_COLUMNS,
  applyTenantCompanyBranding,
  runSaveTenantBillingAccount,
  runSaveTenantCompanyBranding,
  saveTenantBillingAuthorization,
} from '../functions/api/tenant-settings-handlers.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const STAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mapping = { application_user_id: USER };
const spoof = { ignored: true, headerTenantId: OTHER, headerUserId: 'spoof-user' };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const memory = (opts = {}) => {
  const state = {
    membershipRole: opts.membershipRole === undefined ? 'admin' : opts.membershipRole,
    systemRole: opts.systemRole || null,
    master: opts.master === true,
    stakeholder: opts.stakeholder === undefined
      ? {
        id: STAKE,
        tenant_id: TENANT,
        nickname: 'Operating',
        custname: 'Freedom Adjustment',
        acct_type: 'C',
        chk_acct: '1234567890',
        chk_aba: '021000021',
        verification_status: 'verified',
        is_active: true,
        provider: 'moov',
        provider_account_id: 'acct_1',
        provider_bank_account_id: 'bank_1',
        provider_last_four: '7890',
        origin: 'moov',
      }
      : opts.stakeholder,
    methods: opts.methods || [],
    billing: opts.billing || null,
    tenant: {
      id: TENANT,
      name: 'Freedom Adjustment',
      business_address: '1 Main',
      business_phone: '555-0100',
      email_reply_to: 'claims@freedomadj.com',
      logo_url: '/logos/old.png',
      invoice_letterhead_url: null,
      invoice_footer_note: 'Thanks',
      invoice_default_terms: 'Net 15',
      invoice_accent_color: '#111111',
      invoice_theme: 'light',
      primary_color: '#1a56db',
      secondary_color: '#111827',
      partner_code: 'KEEP',
      ...opts.tenant,
    },
    queries: [],
  };

  return {
    state,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ sql: compact, params });
      if (compact.includes('FROM public.tenant_users')) {
        if (params[0] !== TENANT) return { rows: [] };
        return { rows: state.membershipRole ? [{ role: state.membershipRole }] : [] };
      }
      if (compact.includes('FROM public.user_roles')) {
        return { rows: state.systemRole ? [{ role: state.systemRole }] : [] };
      }
      if (compact.includes('is_master_owner')) {
        return { rows: [{ is_master: state.master }] };
      }
      if (compact.includes('FROM public.stakeholder_accounts')) {
        const row = state.stakeholder;
        if (!row) return { rows: [] };
        if (params[0] !== row.id || params[1] !== TENANT) return { rows: [] };
        return { rows: [row] };
      }
      if (compact.includes('FROM public.payment_provider_methods')) {
        return { rows: state.methods };
      }
      if (compact.startsWith('SELECT id, tenant_id, stakeholder_account_id') && compact.includes('tenant_billing_accounts')) {
        return { rows: state.billing ? [state.billing] : [] };
      }
      if (compact.startsWith('INSERT INTO public.tenant_billing_accounts')) {
        assert.equal(params.includes(true) || params.includes(false) || params[3] === true || params[3] === false, true);
        assert.ok(!compact.includes('provider_payment_method_id'));
        assert.match(compact, /routing_number, account_number_encrypted/);
        state.billing = {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tenant_id: params[0],
          account_holder_name: params[1],
          account_number_last4: params[2],
          auto_debit_enabled: params[3],
          ach_authorized_at: params[4],
          ach_authorized_by: params[5],
          verification_status: params[6],
          stakeholder_account_id: params[7],
          nickname: params[8],
          account_type: params[9],
          entity_type: params[10],
          routing_number: params[11],
          account_number_encrypted: params[12],
        };
        return { rows: [state.billing] };
      }
      if (compact.startsWith('UPDATE public.tenant_billing_accounts') && compact.includes('account_holder_name')) {
        state.billing = {
          ...state.billing,
          tenant_id: params[0],
          account_holder_name: params[1],
          account_number_last4: params[2],
          auto_debit_enabled: params[3],
          ach_authorized_at: params[4],
          ach_authorized_by: params[5],
          verification_status: params[6],
          stakeholder_account_id: params[7],
          nickname: params[8],
          account_type: params[9],
          routing_number: params[10] || state.billing?.routing_number,
        };
        return { rows: [state.billing] };
      }
      if (compact.startsWith('UPDATE public.tenant_billing_accounts') && compact.includes('auto_debit_enabled')) {
        state.billing = { ...state.billing, auto_debit_enabled: params[1] };
        return { rows: [state.billing] };
      }
      if (compact.startsWith('UPDATE public.tenants SET')) {
        const tenantId = params[params.length - 1];
        if (tenantId !== TENANT) return { rows: [] };
        const assigns = [...compact.matchAll(/(\w+) = \$\d+/g)].map((m) => m[1]).filter((c) => c !== 'id');
        assigns.forEach((column, index) => {
          if (column === 'updated_at') return;
          state.tenant[column] = params[index];
        });
        return { rows: [{ ...state.tenant }] };
      }
      throw new Error(`unexpected sql: ${compact}`);
    },
  };
};

test('class A billing and branding names keep WalletOps and settings handlers', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('save-tenant-billing-account'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-company-branding-save'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-billing-authorize'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-billing-admin'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-email-branding-save'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-email-branding-get'), true);
});

test('billing save requires tenant admin, verified owned account, and ACH consent', async () => {
  const client = memory({ membershipRole: 'member' });
  const denied = await runSaveTenantBillingAccount({
    client,
    mapping,
    spoof,
    body: { tenant_id: TENANT, stakeholder_account_id: STAKE, authorized: true },
  });
  assert.equal(denied.error, 'not_authorized');
  assert.equal(denied.statusCode, 403);

  const other = await runSaveTenantBillingAccount({
    client: memory(),
    mapping,
    spoof,
    body: { tenant_id: OTHER, stakeholder_account_id: STAKE, authorized: true },
  });
  assert.equal(other.error, 'cross_tenant_denied');

  const missingConsent = await runSaveTenantBillingAccount({
    client: memory(),
    mapping,
    spoof,
    body: { tenant_id: TENANT, stakeholder_account_id: STAKE, authorized: false },
  });
  assert.equal(missingConsent.error, 'ach_authorization_required');

  const unverified = await runSaveTenantBillingAccount({
    client: memory({
      stakeholder: {
        id: STAKE,
        tenant_id: TENANT,
        is_active: true,
        verification_status: 'unverified',
        custname: 'Homeowner',
        chk_acct: '9999',
      },
    }),
    mapping,
    spoof,
    body: {
      tenant_id: TENANT,
      stakeholder_account_id: STAKE,
      authorized: true,
      verification_status: 'verified',
    },
  });
  assert.equal(unverified.error, 'bank_not_verified');
  assert.equal(unverified.verification_status, 'unverified');
});

test('billing save persists consent without charging and ignores client verification timestamps', async () => {
  const client = memory();
  const saved = await runSaveTenantBillingAccount({
    client,
    mapping,
    spoof,
    body: {
      tenant_id: TENANT,
      stakeholder_account_id: STAKE,
      authorized: true,
      auto_debit_enabled: true,
      verification_status: 'admin_override',
      ach_authorized_at: '1999-01-01T00:00:00.000Z',
      amount: 13900,
      charge: true,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.charged, false);
  assert.equal(saved.collection_initiated, false);
  assert.equal(saved.consent_version, BILLING_ACH_CONSENT_VERSION);
  assert.equal(saved.authorization.stakeholder_account_id, STAKE);
  assert.equal(saved.authorization.auto_debit_enabled, true);
  assert.equal(saved.authorization.account_number_last4, '7890');
  assert.notEqual(saved.authorization.ach_authorized_at, '1999-01-01T00:00:00.000Z');
  assert.ok(saved.authorization.ach_authorized_at);
  assert.equal(client.state.billing.ach_authorized_by, USER);
  assert.equal(client.state.billing.verification_status, 'verified');
  assert.equal(client.state.billing.account_number_encrypted, '');
  assert.equal(client.state.billing.routing_number, '021000021');
  assert.deepEqual(saved.ignoredClientFields, [
    'verification_status', 'ach_authorized_at', 'ach_authorized_by', 'amount', 'amount_cents',
  ]);
});

test('changing the selected account and toggling auto-debit update the existing row only', async () => {
  const nextStake = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const client = memory({
    billing: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: TENANT,
      stakeholder_account_id: STAKE,
      auto_debit_enabled: true,
      routing_number: '021000021',
      account_number_encrypted: 'kept',
    },
    stakeholder: {
      id: nextStake,
      tenant_id: TENANT,
      nickname: 'Trust',
      custname: 'Freedom Trust',
      acct_type: 'S',
      chk_acct: '5555',
      chk_aba: '011401533',
      verification_status: 'verified',
      is_active: true,
    },
  });
  const replaced = await runSaveTenantBillingAccount({
    client,
    mapping,
    spoof,
    body: { tenant_id: TENANT, stakeholder_account_id: nextStake, authorized: true },
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.charged, false);
  assert.equal(client.state.billing.stakeholder_account_id, nextStake);
  assert.equal(client.state.billing.account_type, 'savings');
  assert.equal(client.state.billing.account_number_encrypted, 'kept');

  const paused = await runSaveTenantBillingAccount({
    client,
    mapping,
    spoof,
    body: { tenant_id: TENANT, action: 'toggle_auto_debit', auto_debit_enabled: false },
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.authorization.auto_debit_enabled, false);
  assert.equal(paused.collection_initiated, false);

  const resumed = await runSaveTenantBillingAccount({
    client,
    mapping,
    spoof,
    body: { tenant_id: TENANT, action: 'toggle_auto_debit', auto_debit_enabled: true },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.authorization.auto_debit_enabled, true);
  assert.equal(resumed.charged, false);
  assert.equal(resumed.collection_initiated, false);
  assert.equal(client.state.billing.account_number_encrypted, 'kept');
  assert.equal(
    client.state.queries.some((row) => /transfer|collect|charge|moovFetch|\/transfers/i.test(row.sql)),
    false,
  );
});

test('company branding updates only intended tenant fields', async () => {
  const client = memory();
  const saved = await runSaveTenantCompanyBranding({
    client,
    mapping,
    spoof,
    body: {
      tenant_id: TENANT,
      company_name: 'Freedom Claims',
      company_address: '100 Broad St',
      company_phone: '215-555-0100',
      company_email: 'hello@freedomadj.com',
      logo_url: 'https://cdn.freedomadj.com/logo.png',
      invoice_letterhead_url: 'https://cdn.freedomadj.com/letter.png',
      invoice_footer_note: 'Pay in 15',
      invoice_default_terms: 'Net 30',
      invoice_accent_color: '#3B82F6',
      invoice_theme: 'dark',
      partner_code: 'HACK',
      monthly_rate_cents: 1,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.tenant.name, 'Freedom Claims');
  assert.equal(saved.tenant.business_address, '100 Broad St');
  assert.equal(saved.tenant.business_phone, '215-555-0100');
  assert.equal(saved.tenant.email_reply_to, 'hello@freedomadj.com');
  assert.equal(saved.tenant.logo_url, 'https://cdn.freedomadj.com/logo.png');
  assert.equal(saved.tenant.invoice_theme, 'dark');
  assert.equal(saved.tenant.partner_code, 'KEEP');
  assert.ok(!saved.updatedFields.includes('partner_code'));
  assert.ok(TENANT_BRANDING_COLUMNS.includes('invoice_accent_color'));

  const invalid = await applyTenantCompanyBranding(client, TENANT, { invoice_accent_color: 'red' });
  assert.equal(invalid.error, 'invalid_field');

  const reloaded = { ...client.state.tenant };
  assert.equal(reloaded.logo_url, 'https://cdn.freedomadj.com/logo.png');
  assert.equal(reloaded.invoice_letterhead_url, 'https://cdn.freedomadj.com/letter.png');
  assert.equal(reloaded.invoice_accent_color, '#3b82f6');
  assert.equal(reloaded.invoice_footer_note, 'Pay in 15');
  assert.equal(reloaded.invoice_default_terms, 'Net 30');
  assert.equal(reloaded.invoice_theme, 'dark');
});

test('branding save denies non-admins and does not invent company_branding writes', async () => {
  const denied = await runSaveTenantCompanyBranding({
    client: memory({ membershipRole: 'member' }),
    mapping,
    spoof,
    body: { tenant_id: TENANT, company_name: 'Nope' },
  });
  assert.equal(denied.error, 'not_authorized');
  const src = read('aws/functions/api/tenant-settings-handlers.mjs');
  assert.doesNotMatch(src, /company_branding/);
  assert.match(src, /UPDATE public\.tenants SET/);
});

test('reconciled dispatcher keeps WalletOps funding wrap and stakeholder bank sync', () => {
  const moov = read('aws/functions/api/providers/parity/moov-functions.mjs');
  const app = read('aws/functions/api/app-services.mjs');
  assert.match(moov, /wrapPlatformOwnerRead/);
  assert.match(moov, /reconcileStakeholderBankStatuses/);
  assert.match(moov, /initiate-wallet-funding/);
  assert.match(app, /handleSaveTenantBillingAccount/);
  assert.match(app, /handleTenantBillingAuthorize/);
  assert.match(app, /handleSaveTenantCompanyBranding/);
  assert.match(app, /tenant-email-branding-save/);
});

test('SPA billing and branding use the Class A paths instead of generic writes', () => {
  const billing = read('src/components/settings/TenantBillingAccountPanel.tsx');
  const company = read('src/components/settings/CompanyBrandingSettings.tsx');
  const email = read('src/components/settings/EmailSenderSettings.tsx');
  const allowlist = read('aws/functions/api/write-allowlist.mjs');
  assert.match(billing, /save-tenant-billing-account/);
  assert.match(billing, /authorized: true/);
  assert.match(billing, /collection_initiated/);
  assert.doesNotMatch(billing, /\.from\("tenant_billing_accounts"\)[\s\S]*\.(insert|update|upsert)/);
  assert.match(company, /tenant-company-branding-save/);
  assert.match(company, /tenant-logos/);
  assert.match(company, /canonicalStoredTenantLogo/);
  assert.match(company, /Invoices use the same logo configured in Branding & Appearance/);
  assert.doesNotMatch(company, /company_branding/);
  assert.match(email, /tenant-email-branding-save/);
  assert.match(email, /primaryColor/);
  assert.match(email, /logoUrl/);
  assert.doesNotMatch(email, /Sending subdomain/);
  assert.doesNotMatch(email, /tenant-domain-verify/);
  assert.doesNotMatch(allowlist, /tenant_billing_accounts/);
});

test('direct billing helper never starts a collection when amount is supplied', async () => {
  const client = memory();
  const saved = await saveTenantBillingAuthorization(client, {
    tenantId: TENANT,
    userId: USER,
    stakeholderId: STAKE,
    authorized: true,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.charged, false);
  assert.equal(saved.collection_initiated, false);
});
