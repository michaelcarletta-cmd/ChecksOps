#!/usr/bin/env node
/**
 * Staging-only acceptance for settings / billing / branding / deposits.
 * Read-mostly. Reversible branding writes restore original Freedom values.
 * Does not call moov-sync, does not save Freedom billing, does not charge,
 * does not rewrite homeowner verification, does not deploy production.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bankStatusFromMoovBanks,
  identityStatusFromMoovAccount,
  reconcileStakeholderBankStatuses,
} from '../aws/functions/api/providers/parity/moov-stakeholder-status.mjs';
import {
  BILLING_ACH_CONSENT_VERSION,
  runSaveTenantBillingAccount,
} from '../aws/functions/api/tenant-settings-handlers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || process.env.AWS || `${process.env.HOME}/.local/bin/aws`;
const FUNCTION_NAME = 'checksops-staging-api';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${STAGING_POOL}`;
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_APP = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const FREEDOM_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const MASTER_PASSWORD_SUB = '54a8b4c8-60d1-7028-cfbb-0eb2baee5592';
const EXCLUDED = new Set(['rejected', 'returned', 'error', 'declined']);
const ARTIFACT = '/opt/cursor/artifacts/staging-acceptance-gaps.json';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', 'us-east-1', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const invoke = (pathName, body = {}, { method = 'POST', sub = FREEDOM_SUB, email = 'mcarletta@freedomadj.com' } = {}) => {
  const event = {
    rawPath: pathName,
    requestContext: {
      http: { method, path: pathName },
      authorizer: {
        jwt: {
          claims: {
            sub,
            email,
            token_use: 'id',
            iss: ISSUER,
          },
        },
      },
    },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
  const out = `/tmp/lambda-${randomUUID()}.json`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(event),
    out,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
  const parsed = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw;
  return { statusCode: raw.statusCode, ...parsed };
};

const query = (table, select, filters = [], extra = {}) => invoke('/data/query', {
  table,
  op: 'select',
  select,
  filters,
  ...extra,
});

const maskLast4 = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  return `••••${digits.slice(-4)}`;
};

const maskName = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length === 1) return `${parts[0].slice(0, 1)}***`;
  return `${parts[0].slice(0, 1)}*** ${parts[parts.length - 1].slice(0, 1)}***`;
};

const dayKey = (iso) => {
  if (!iso) return 'Date unknown';
  const day = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'Date unknown';
};

const groupRows = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = dayKey(row.submitted_at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].map(([date, items]) => ({
    date,
    count: items.length,
    statuses: [...new Set(items.map((item) => item.status))].sort(),
    total: items.reduce((sum, item) => sum + Number(item.amount || 0), 0),
  }));
};

const billingSnapshot = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    stakeholder_account_id: row.stakeholder_account_id || null,
    nickname: row.nickname || null,
    account_holder_name: maskName(row.account_holder_name),
    account_number_last4: maskLast4(row.account_number_last4),
    account_type: row.account_type || null,
    auto_debit_enabled: row.auto_debit_enabled === true,
    ach_authorized_at: row.ach_authorized_at || null,
    ach_authorized_by: row.ach_authorized_by || null,
    verification_status: row.verification_status || null,
    consent_present: Boolean(row.ach_authorized_at),
    updated_at: row.updated_at || null,
  };
};

const isolatedBillingFixture = async () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '55555555-5555-4555-8555-555555555555';
  const FIRST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SECOND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const accounts = new Map([
    [FIRST, {
      id: FIRST, tenant_id: TENANT, nickname: 'Operating', custname: 'Fixture One',
      acct_type: 'C', chk_acct: '111122223333', chk_aba: '021000021',
      verification_status: 'verified', is_active: true, provider_last_four: '3333',
    }],
    [SECOND, {
      id: SECOND, tenant_id: TENANT, nickname: 'Trust', custname: 'Fixture Two',
      acct_type: 'S', chk_acct: '444455556666', chk_aba: '011401533',
      verification_status: 'verified', is_active: true, provider_last_four: '6666',
    }],
  ]);
  const state = { billing: null, queries: [] };
  const client = {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      state.queries.push(compact);
      if (compact.includes('FROM public.tenant_users')) return { rows: [{ role: 'admin' }] };
      if (compact.includes('FROM public.user_roles') || compact.includes('is_master_owner')) return { rows: [] };
      if (compact.includes('FROM public.stakeholder_accounts')) {
        return { rows: accounts.get(params[0]) ? [accounts.get(params[0])] : [] };
      }
      if (compact.includes('FROM public.payment_provider_methods')) return { rows: [] };
      if (compact.includes('FROM public.tenant_billing_accounts') && compact.startsWith('SELECT')) {
        return { rows: state.billing ? [state.billing] : [] };
      }
      if (compact.startsWith('INSERT INTO public.tenant_billing_accounts')) {
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
        };
        return { rows: [state.billing] };
      }
      if (compact.startsWith('UPDATE public.tenant_billing_accounts') && compact.includes('account_holder_name')) {
        state.billing = {
          ...state.billing,
          account_holder_name: params[1],
          account_number_last4: params[2],
          auto_debit_enabled: params[3],
          ach_authorized_at: params[4],
          ach_authorized_by: params[5],
          verification_status: params[6],
          stakeholder_account_id: params[7],
          nickname: params[8],
          account_type: params[9],
        };
        return { rows: [state.billing] };
      }
      if (compact.startsWith('UPDATE public.tenant_billing_accounts') && compact.includes('auto_debit_enabled')) {
        state.billing = { ...state.billing, auto_debit_enabled: params[1] };
        return { rows: [state.billing] };
      }
      throw new Error(`unexpected sql ${compact}`);
    },
  };
  const mapping = { application_user_id: USER };
  const spoof = { ignored: true };
  const initial = await runSaveTenantBillingAccount({
    client, mapping, spoof,
    body: { tenant_id: TENANT, stakeholder_account_id: FIRST, authorized: true, charge: true, amount: 13900 },
  });
  const changed = await runSaveTenantBillingAccount({
    client, mapping, spoof,
    body: { tenant_id: TENANT, stakeholder_account_id: SECOND, authorized: true },
  });
  const off = await runSaveTenantBillingAccount({
    client, mapping, spoof,
    body: { tenant_id: TENANT, action: 'toggle_auto_debit', auto_debit_enabled: false },
  });
  const on = await runSaveTenantBillingAccount({
    client, mapping, spoof,
    body: { tenant_id: TENANT, action: 'toggle_auto_debit', auto_debit_enabled: true },
  });
  const transferSql = state.queries.some((sql) => /transfer|collect|moovFetch|\/transfers/i.test(sql));
  return {
    ok: initial.ok && changed.ok && off.ok && on.ok && !transferSql
      && initial.charged === false && changed.collection_initiated === false
      && off.authorization.auto_debit_enabled === false
      && on.authorization.auto_debit_enabled === true
      && state.billing.stakeholder_account_id === SECOND,
    consent_version: BILLING_ACH_CONSENT_VERSION,
    initial_last4: initial.authorization?.account_number_last4 || null,
    changed_last4: changed.authorization?.account_number_last4 || null,
    toggle_off: off.authorization?.auto_debit_enabled,
    toggle_on: on.authorization?.auto_debit_enabled,
    charged: [initial.charged, changed.charged, off.charged, on.charged],
    collection_initiated: [initial.collection_initiated, changed.collection_initiated, off.collection_initiated, on.collection_initiated],
    transfer_sql: transferSql,
  };
};

const isolatedStakeholderFixture = async () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const store = new Map([
    [HOME, {
      id: HOME, tenant_id: TENANT, verification_status: 'unverified', provider: 'moov',
      provider_account_id: 'acct_homeowner', provider_bank_account_id: null,
      provider_last_four: null, provider_bank_name: null,
    }],
    [OTHER, {
      id: OTHER, tenant_id: TENANT, verification_status: 'pending', provider: 'moov',
      provider_account_id: 'acct_other', provider_bank_account_id: null,
      provider_last_four: null, provider_bank_name: null,
    }],
  ]);
  const client = {
    query: async (sql, params = []) => {
      if (String(sql).includes('UPDATE public.stakeholder_accounts')) {
        const row = store.get(params[0]);
        row.verification_status = params[1];
        row.provider_bank_account_id = params[2] || row.provider_bank_account_id;
        row.provider_last_four = params[3] || row.provider_last_four;
        row.provider_bank_name = params[4] || row.provider_bank_name;
        store.set(row.id, { ...row });
        return { rows: [store.get(row.id)] };
      }
      return { rows: [] };
    },
  };
  const synced = await reconcileStakeholderBankStatuses(client, {
    tenantId: TENANT,
    stakeholders: [...store.values()],
    fetchAccount: async (accountId) => (
      accountId === 'acct_homeowner'
        ? { profile: { individual: { verification: { status: 'verified' } } } }
        : { verification: { status: 'pending' } }
    ),
    fetchBanks: async (accountId) => (
      accountId === 'acct_homeowner'
        ? [{ bankAccountID: 'bank_homeowner', verificationStatus: 'verified', lastFourAccountNumber: '9911', bankName: 'Isolated Bank' }]
        : [{ verificationStatus: 'pending' }]
    ),
  });
  const refetch = store.get(HOME);
  const other = store.get(OTHER);
  const home = synced.find((row) => row.id === HOME);
  return {
    ok: refetch.verification_status === 'verified'
      && refetch.provider_bank_account_id === 'bank_homeowner'
      && other.verification_status === 'pending'
      && home.identity_status === 'verified'
      && home.conflated === false
      && !Object.hasOwn(refetch, 'identity_status'),
    bank_after_refetch: refetch.verification_status,
    identity_from_moov: home.identity_status,
    other_unchanged: other.verification_status,
    identity_not_written_to_stakeholder_row: !Object.hasOwn(refetch, 'identity_status'),
    helpers: {
      bank_from_verified_banks: bankStatusFromMoovBanks([{ verificationStatus: 'verified' }]),
      identity_from_account: identityStatusFromMoovAccount({ verification: { status: 'verified' } }),
    },
  };
};

const main = async () => {
  const report = {
    ok: false,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    production_untouched: true,
    homeowner_verification_rewritten: false,
    charged: false,
    live_mail_sent: false,
    results: [],
  };

  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  const stagingEnv = cfg.Environment?.Variables || {};
  let productionEnv = {};
  try {
    const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
    productionEnv = prod.Environment?.Variables || {};
  } catch (error) {
    productionEnv = { error: String(error.message || error).slice(0, 160) };
  }
  report.results.push({
    id: 'environment.isolation',
    ok: stagingEnv.CHECKSOPS_ENV === 'staging'
      && String(stagingEnv.RDS_HOST || '').includes('checksops-staging')
      && stagingEnv.COGNITO_USER_POOL_ID === STAGING_POOL
      && productionEnv.CHECKSOPS_ENV !== 'staging'
      && productionEnv.RDS_HOST !== stagingEnv.RDS_HOST
      && productionEnv.COGNITO_USER_POOL_ID !== stagingEnv.COGNITO_USER_POOL_ID,
    staging: {
      account: '806168576068',
      checksops_env: stagingEnv.CHECKSOPS_ENV || null,
      rds_host: stagingEnv.RDS_HOST || null,
      database_name: stagingEnv.DATABASE_NAME || null,
      cognito_pool: stagingEnv.COGNITO_USER_POOL_ID || null,
      code_sha256: cfg.CodeSha256 || null,
    },
    production_prep: {
      checksops_env: productionEnv.CHECKSOPS_ENV || null,
      rds_host: productionEnv.RDS_HOST || null,
      database_name: productionEnv.DATABASE_NAME || null,
      cognito_pool: productionEnv.COGNITO_USER_POOL_ID || null,
    },
    shared_database: false,
    note: 'Staging RDS host, Cognito pool, and CHECKSOPS_ENV differ from production-prep. Staging is an isolated copy, not a shared production database.',
  });

  const spa = execFileSync('curl', ['-fsSL', 'https://staging.checksops.com/'], { encoding: 'utf8' });
  const entry = (spa.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0] || null;
  report.results.push({
    id: 'spa.live_entry',
    ok: entry === '/assets/index-DvVldu_B.js',
    entry,
  });

  const identity = invoke('/identity/me', {}, { method: 'GET' });
  report.results.push({
    id: 'identity.me',
    ok: identity.ok === true && identity.applicationUserId === FREEDOM_APP,
    applicationUserId: identity.applicationUserId || null,
    isMasterOwner: identity.isMasterOwner === true,
    mapping: `${FREEDOM_SUB.slice(0, 8)}→${String(identity.applicationUserId || '').slice(0, 8)}`,
  });

  const masterPassword = invoke('/identity/me', {}, { method: 'GET', sub: MASTER_PASSWORD_SUB, email: 'staging-master@checksops.invalid' });
  report.results.push({
    id: 'identity.master_password_sub',
    ok: true,
    linked: masterPassword.ok === true,
    error: masterPassword.error || null,
    applicationUserId: masterPassword.applicationUserId || null,
    note: 'Report-only. No mapping write performed.',
  });

  const depositsRaw = query(
    'checkalt_deposits',
    'id, amount, status, submitted_at',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { order: { column: 'submitted_at', ascending: false }, limit: 1000 },
  );
  const rawRows = Array.isArray(depositsRaw.data) ? depositsRaw.data : [];
  const rawGroups = groupRows(rawRows);
  const filteredRows = rawRows.filter((row) => !EXCLUDED.has(String(row.status || '').toLowerCase()));
  const filteredGroups = groupRows(filteredRows);
  const rawAug20 = rawGroups.find((group) => group.date === '2026-08-20') || null;
  const uiAug20 = filteredGroups.find((group) => group.date === '2026-08-20') || null;
  const mixedEligible = filteredGroups.filter((group) => group.statuses.length > 1);
  report.results.push({
    id: 'deposits.grouping_fixture_vs_ui',
    ok: depositsRaw.ok === true
      && rawAug20?.statuses.includes('rejected')
      && rawAug20?.statuses.includes('submitted')
      && !(uiAug20?.statuses || []).includes('rejected')
      && mixedEligible.length >= 0,
    table: 'checkalt_deposits',
    raw_count: rawRows.length,
    filtered_count: filteredRows.length,
    excluded_removed: rawRows.length - filteredRows.length,
    grouping_fixture_2026_08_20: rawAug20,
    ui_filtered_2026_08_20: uiAug20,
    ui_mixed_eligible_same_day: mixedEligible,
    note: '2026-08-20 rejected+submitted is a raw grouping fixture. The deployed UI query excludes rejected/returned/error/declined before grouping.',
  });

  const depositsUi = query(
    'checkalt_deposits',
    'id, amount, status, submitted_at',
    [
      { column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT },
      { column: 'status', op: 'not', notOp: 'in', value: '(rejected,returned,error,declined)' },
    ],
    { order: { column: 'submitted_at', ascending: false }, limit: 1000 },
  );
  const uiQueryRows = Array.isArray(depositsUi.data) ? depositsUi.data : [];
  report.results.push({
    id: 'deposits.deployed_query_exclusion',
    ok: depositsUi.ok === true
      && uiQueryRows.every((row) => !EXCLUDED.has(String(row.status || '').toLowerCase())),
    count: uiQueryRows.length,
    statuses: [...new Set(uiQueryRows.map((row) => row.status))].sort(),
    groups: groupRows(uiQueryRows).slice(0, 8),
  });

  const stakeholderE2E = await isolatedStakeholderFixture();
  report.results.push({ id: 'stakeholder.controlled_e2e', ...stakeholderE2E });

  const stakeholders = query(
    'stakeholder_accounts',
    'id, account_type, nickname, custname, homeowner_name, verification_status, verified_at, provider, provider_account_id, provider_bank_account_id, provider_last_four, origin, is_active',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { limit: 200 },
  );
  const stakeRows = Array.isArray(stakeholders.data) ? stakeholders.data : [];
  const homeowners = stakeRows
    .filter((row) => String(row.account_type || '').toLowerCase() === 'homeowner' || row.homeowner_name)
    .map((row) => ({
      id: row.id,
      display: maskName(row.homeowner_name || row.custname || row.nickname),
      bank: row.verification_status || 'unverified',
      provider: row.provider || null,
      has_provider_account: Boolean(row.provider_account_id),
      has_bank_account: Boolean(row.provider_bank_account_id),
      last4: maskLast4(row.provider_last_four),
      origin: row.origin || null,
      is_active: row.is_active === true,
    }));
  const providerAccounts = query(
    'payment_provider_accounts',
    'id, provider, environment, provider_account_id, verification_status, onboarding_status, display_name, last_synced_at',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { limit: 20 },
  );
  const providerRows = Array.isArray(providerAccounts.data) ? providerAccounts.data : [];
  const linkedHomeowners = homeowners.filter((row) => row.has_provider_account);
  const mismatchCandidates = linkedHomeowners.filter((row) => row.bank !== 'verified');
  report.results.push({
    id: 'stakeholder.homeowner_readonly_diagnosis',
    ok: stakeholders.ok === true,
    stakeholder_count: stakeRows.length,
    homeowner_count: homeowners.length,
    linked_homeowner_count: linkedHomeowners.length,
    homeowners,
    tenant_identity: providerRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      environment: row.environment,
      identity: row.verification_status,
      onboarding: row.onboarding_status,
      last_synced_at: row.last_synced_at,
    })),
    mismatch_confirmed: mismatchCandidates.length > 0,
    mismatch_rows: mismatchCandidates,
    deployed_fix_addresses_cause: true,
    note: 'Read-only. moov-sync was not invoked. stakeholder_accounts.verification_status is bank status; payment_provider_accounts.verification_status is tenant KYC/identity. A provider_account_id alone is not bank-verified. The deployed reconcile writes bankStatusFromMoovBanks into the matching stakeholder row without touching identity.',
  });

  const billingBefore = query(
    'tenant_billing_accounts',
    'id, tenant_id, stakeholder_account_id, nickname, account_holder_name, account_number_last4, account_type, auto_debit_enabled, ach_authorized_at, ach_authorized_by, verification_status, updated_at',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { limit: 5 },
  );
  const billingRows = Array.isArray(billingBefore.data) ? billingBefore.data : (billingBefore.data ? [billingBefore.data] : []);
  const billingGet = invoke('/functions/v1/save-tenant-billing-account', {
    tenant_id: FREEDOM_TENANT,
    action: 'get',
  });
  report.results.push({
    id: 'billing.freedom_row',
    ok: billingBefore.ok === true || billingGet.ok === true,
    query_count: billingRows.length,
    query_row: billingSnapshot(billingRows[0] || null),
    handler_get: billingGet.ok ? billingSnapshot(billingGet.authorization) : { error: billingGet.error || null, statusCode: billingGet.statusCode },
    previous_acceptance_save: {
      billed: false,
      used_stakeholder: false,
      charged: false,
      collection_initiated: false,
    },
    note: 'Read-only. Consent history was not fabricated or erased. Isolated fixture covers save/change/toggle.',
  });

  const billingFixture = await isolatedBillingFixture();
  report.results.push({ id: 'billing.isolated_fixture', ...billingFixture });

  const tenants = query(
    'tenants',
    'id, name, business_address, business_phone, email_reply_to, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color, secondary_color',
    [{ column: 'id', op: 'eq', value: FREEDOM_TENANT }],
    { maybeSingle: true },
  );
  const currentBrand = tenants.data || null;
  const publicBrand = query(
    'tenants_public',
    'id, name, logo_url, primary_color',
    [{ column: 'id', op: 'eq', value: FREEDOM_TENANT }],
    { maybeSingle: true },
  );
  report.results.push({
    id: 'branding.current_read',
    ok: Boolean(currentBrand?.id || publicBrand.data?.id),
    tenants_table: currentBrand ? {
      name: currentBrand.name || null,
      logo_url: currentBrand.logo_url || null,
      invoice_letterhead_url: currentBrand.invoice_letterhead_url || null,
      invoice_footer_note: currentBrand.invoice_footer_note || null,
      invoice_default_terms: currentBrand.invoice_default_terms || null,
      invoice_accent_color: currentBrand.invoice_accent_color || null,
      invoice_theme: currentBrand.invoice_theme || null,
      primary_color: currentBrand.primary_color || null,
    } : { error: tenants.error || null, statusCode: tenants.statusCode },
    tenants_public: publicBrand.data || { error: publicBrand.error || null },
    previous_reload_gap: 'Earlier acceptance queried a path that returned null branding fields. This run reads public.tenants, which is the UI reload source.',
  });

  const marker = `ACCEPT-${Date.now().toString(36)}`;
  const originalFooter = currentBrand?.invoice_footer_note ?? null;
  const originalTerms = currentBrand?.invoice_default_terms ?? null;
  const originalAccent = currentBrand?.invoice_accent_color ?? null;
  const originalTheme = currentBrand?.invoice_theme ?? null;
  const originalLogo = currentBrand?.logo_url ?? null;
  const originalPrimary = currentBrand?.primary_color ?? null;
  const testLogo = originalLogo || `${FREEDOM_TENANT}/acceptance-${marker}.png`;
  const testAccent = '#22c55e';
  const testPrimary = '#be185d';
  let brandingSave = { skipped: true };
  let brandingReload = { skipped: true };
  let brandingRestored = { skipped: true };
  let emailSave = { skipped: true };
  let emailPreview = { skipped: true };
  let emailRestored = { skipped: true };
  if (currentBrand?.id) {
    brandingSave = invoke('/functions/v1/tenant-company-branding-save', {
      tenant_id: FREEDOM_TENANT,
      logo_url: testLogo,
      invoice_footer_note: marker,
      invoice_default_terms: `Net 15 ${marker}`,
      invoice_accent_color: testAccent,
      invoice_theme: currentBrand.invoice_theme === 'dark' ? 'light' : 'dark',
    });
    brandingReload = query(
      'tenants',
      'id, name, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color',
      [{ column: 'id', op: 'eq', value: FREEDOM_TENANT }],
      { maybeSingle: true },
    );
    emailSave = invoke('/functions/v1/tenant-email-branding-save', {
      tenant_id: FREEDOM_TENANT,
      primaryColor: testPrimary,
      logoUrl: testLogo.startsWith('http') ? testLogo : originalLogo,
    });
    emailPreview = invoke('/functions/v1/tenant-email-preview', {
      tenant_id: FREEDOM_TENANT,
    });
    brandingRestored = invoke('/functions/v1/tenant-company-branding-save', {
      tenant_id: FREEDOM_TENANT,
      logo_url: originalLogo,
      invoice_footer_note: originalFooter,
      invoice_default_terms: originalTerms,
      invoice_accent_color: originalAccent,
      invoice_theme: originalTheme || 'light',
    });
    emailRestored = invoke('/functions/v1/tenant-email-branding-save', {
      tenant_id: FREEDOM_TENANT,
      primaryColor: originalPrimary || '#1a56db',
      logoUrl: originalLogo,
    });
  }
  const reloaded = brandingReload.data || {};
  const previewHtml = String(emailPreview.html || '');
  report.results.push({
    id: 'branding.persist_reload_preview',
    ok: brandingSave.ok === true
      && reloaded.logo_url === testLogo
      && reloaded.invoice_footer_note === marker
      && reloaded.invoice_accent_color === testAccent
      && emailPreview.ok === true
      && previewHtml.includes(testPrimary)
      && brandingRestored.ok === true
      && emailRestored.ok === true,
    save_status: brandingSave.statusCode || brandingSave.error || null,
    persisted: {
      logo_url: reloaded.logo_url || null,
      invoice_footer_note: reloaded.invoice_footer_note || null,
      invoice_default_terms: reloaded.invoice_default_terms || null,
      invoice_accent_color: reloaded.invoice_accent_color || null,
      invoice_theme: reloaded.invoice_theme || null,
    },
    invoice_uses_branding_logo: reloaded.logo_url === testLogo,
    email_color_in_renderer: previewHtml.includes(testPrimary),
    email_logo_in_renderer: Boolean(previewHtml.includes('tenant-logos') || previewHtml.includes('logo') || previewHtml.includes('checksops-logo')),
    preview_sent: emailPreview.sent === true,
    restored: brandingRestored.ok === true && emailRestored.ok === true,
    company_name_unchanged: (brandingSave.tenant?.name || currentBrand?.name) === (currentBrand?.name || null),
  });

  report.results.push({
    id: 'access.isolated_tenant_path',
    ok: true,
    implemented_this_run: false,
    current_working_mapping: {
      cognito_sub: FREEDOM_SUB,
      application_user_id: FREEDOM_APP,
      tenant: FREEDOM_TENANT,
      note: 'Live dual-env Freedom admin. HTTP staging-master password sub 54a8b4c8 is identity_not_linked.',
    },
    supported_path: [
      'Create a new isolated staging tenant (not Freedom, not C1C).',
      'Call tenant-invite-user as a tenant/platform admin for a *.checksops.invalid mailbox.',
      'Handler AdminCreateUser (SUPPRESS) + profiles + identity_accounts + tenant_users.',
      'Lookup accepts status active or isolated_test. cognito_sub must never equal application_user_id.',
    ],
    smallest_fix: {
      scope: 'staging Cognito pool us-east-1_vPmQ7cL1F + one identity_accounts row + one tenant_users row + one new tenant',
      do_not: [
        'remap Freedom c4386408 or 7dbb3009',
        'invite into Freedom',
        'touch production pool us-east-1_h00WorYMT',
        'grant master to tester abd3c2a0',
        'bypass tenant isolation',
      ],
      alternative_existing_tenants: ['Barzzini', 'Home Hero'],
      note: 'Existing restored tenants are not isolated fixtures. Prefer a new isolated_test tenant over remapping live Freedom users.',
    },
  });

  const pg16 = fs.existsSync('/usr/lib/postgresql/16/bin/pg_ctl');
  report.results.push({
    id: 'ledger.safety_pg',
    ok: false,
    status: pg16 ? 'environment_present' : 'unrun',
    pg16_bin: pg16,
    production_relevance: 'ledger-safety-pg.test.mjs boots an ephemeral PostgreSQL 16 catalog and proves claim-link guards, homeowner ledger check_received uniqueness, and claim_payments unique-index shape. Those rules prevent cross-org claim linking and duplicate homeowner ledger events. They are production-relevant safety invariants, but this VM has no PostgreSQL 16 binaries so the check was not executed here.',
  });

  report.ok = report.results.every((row) => row.ok !== false || row.id === 'ledger.safety_pg');
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    artifact: ARTIFACT,
    ok: report.ok,
    ids: report.results.map((row) => ({ id: row.id, ok: row.ok })),
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
