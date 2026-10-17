/**
 * Tenant fee collection (owner decision 2026-10-17): the platform owner
 * collects fees manually from Tenant Management. API-side gates (no
 * database): the production credential helper, who may pull, browser amounts,
 * the preview hash requirement, an unset destination, the retired scheduler
 * and moov-tenant-fee-charge, the destination pins and the one per-check
 * default. The database side (preview = pull amount, idempotency, audit,
 * price stamping) is tenant-fee-collection-sql98-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isProductionChecksOpsRuntime } from '../functions/api/provider-flags.mjs';
import {
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  billingEnvironment,
  normalizeDest,
  resolveBillingDestination,
  resolveBillingMoovContext,
  setBillingDestination,
} from '../functions/api/tenant-billing-destination.mjs';
import {
  CHECK_BILLING_DEFAULT_PRICE_SQL,
  INVOICE_EMAIL_AFTER_PULL,
  MANUAL_BILLING_ONLY,
  PER_CHECK_OFF_BILLS_DEFAULT_PRICE,
  billingPreviewHash,
  chargeTenantPeriod,
  isChargeableCents,
  resolveCheckRateCents,
  runMonthlyBillingScheduler,
  submitVerificationOccurrence,
} from '../functions/api/tenant-billing-engine.mjs';
import {
  CLIENT_AMOUNT_FIELDS,
  handleMonthlyBillingScheduled,
  handleTenantBillingAdmin,
} from '../functions/api/tenant-billing-handlers.mjs';
import { tenantFeeCharge } from '../functions/api/providers/parity/moov-money.mjs';
import { MOOV_PARITY_HANDLERS } from '../functions/api/providers/parity/moov-functions.mjs';
import {
  CHECKSOPS_PLATFORM_ACCOUNT_ID,
  CHECKSOPS_PLATFORM_WALLET_PM_ID,
  PRODUCTION_FEE_DESTINATION,
  assertExplicitDestination,
  collectTenantObligation,
} from '../functions/api/tenant-collection-v2.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Records every query; answers is_platform_owner() and nothing else. */
const fakeClient = ({ owner = false } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner, is_owner: owner }] };
      return { rows: [] };
    },
  };
};

const admin = (body, client) => handleTenantBillingAdmin(
  { body: JSON.stringify(body) },
  { client, mapping: { application_user_id: USER }, ignoreEnabledFlag: true },
);

test('isProductionChecksOpsRuntime: production and production-prep only, the same test as identity-env', async () => {
  for (const value of ['production', 'production-prep', ' Production ', 'PRODUCTION-PREP']) {
    assert.equal(isProductionChecksOpsRuntime(value), true, value);
  }
  for (const value of ['staging', '', undefined, null, 'productionx', 'prod', 'sandbox', 'production prep']) {
    assert.equal(isProductionChecksOpsRuntime(value), false, String(value));
  }
  await withEnv({ CHECKSOPS_ENV: 'production-prep' }, async () => {
    assert.equal(isProductionChecksOpsRuntime(), true);
    assert.equal(billingEnvironment(), 'production');
  });
  await withEnv({ CHECKSOPS_ENV: 'staging' }, async () => {
    assert.equal(isProductionChecksOpsRuntime(), false);
    assert.equal(billingEnvironment(), 'sandbox');
  });
  // 'productionx' used to count as production in billingEnvironment (startsWith).
  await withEnv({ CHECKSOPS_ENV: 'productionx' }, async () => assert.equal(billingEnvironment(), 'sandbox'));
});

test('the production credential step works: it no longer throws, binds production keys only on production', async () => {
  const keys = async () => ({
    secrets: { MOOV_PUBLIC_KEY: 'pk_live', MOOV_SECRET_KEY: 'sk_live', MOOV_ACCOUNT_ID: CHECKSOPS_PLATFORM_ACCOUNT_ID },
    moov: { publicKey: 'pk_sand', secretKey: 'sk_sand', platformAccountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID },
  });
  await withEnv({ CHECKSOPS_ENV: 'production-prep' }, async () => {
    const ctx = await resolveBillingMoovContext({ environment: 'production', deps: { loadSandboxCredentials: keys } });
    assert.equal(ctx.ok, true);
    assert.equal(ctx.moovContext.environment, 'production');
    assert.equal(ctx.moovContext.productionSecretKey, 'sk_live');
    assert.equal(ctx.moovContext.sandboxSecretKey, null);
    const missing = await resolveBillingMoovContext({
      environment: 'production',
      deps: { loadSandboxCredentials: async () => ({ secrets: {}, moov: { publicKey: 'pk_sand', secretKey: 'sk_sand' } }) },
    });
    assert.equal(missing.error, 'production_credentials_unavailable');
  });
  await withEnv({ CHECKSOPS_ENV: 'staging' }, async () => {
    const refused = await resolveBillingMoovContext({ environment: 'production', deps: { loadSandboxCredentials: keys } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'production_credentials_refused');
  });
  // The import the release excluded as broken now resolves.
  assert.match(read('aws/functions/api/provider-flags.mjs'), /export const isProductionChecksOpsRuntime/);
});

test('members, partners and anyone but the platform owner get nothing from billing admin', async () => {
  const actions = [
    { action: 'preview', tenant_id: TENANT },
    { action: 'pull', tenant_id: TENANT, period: '2026-09', preview_hash: HASH, confirm: true },
    { action: 'verify-debit', tenant_id: TENANT, verification_id: USER, confirm: true },
    { action: 'destination-get' },
    { action: 'destination-set', moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: USER },
    { action: 'get', tenant_id: TENANT },
  ];
  for (const body of actions) {
    const client = fakeClient({ owner: false });
    const res = await admin(body, client);
    assert.equal(res.statusCode, 403, body.action);
    assert.equal(res.error, 'platform_owner_required', body.action);
    assert.equal(client.queries.length, 1, `${body.action}: only the owner check ran`);
  }
});

test('a browser-supplied amount on a pull is refused before any charge work', async () => {
  for (const field of CLIENT_AMOUNT_FIELDS) {
    const client = fakeClient({ owner: true });
    const value = field.startsWith('line') ? [{ label: 'x', amount_cents: 1 }] : 100;
    const res = await admin({
      action: 'pull', tenant_id: TENANT, period: '2026-09', preview_hash: HASH, confirm: true, [field]: value,
    }, client);
    assert.equal(res.statusCode, 400, field);
    assert.equal(res.error, 'client_amount_refused', field);
    assert.equal(res.charged, undefined);
    assert.equal(client.queries.some((q) => /tenant_maintenance_payments|pg_advisory|record_billing_audit/.test(q.sql)), false, field);
  }
});

test('a pull needs confirmation and the server preview hash; nothing is booked without them', async () => {
  const noConfirm = fakeClient({ owner: true });
  const r1 = await admin({ action: 'pull', tenant_id: TENANT, period: '2026-09', preview_hash: HASH }, noConfirm);
  assert.equal(r1.error, 'confirmation_required');
  for (const previewHash of [undefined, '', 'abc', 'g'.repeat(64)]) {
    const client = fakeClient({ owner: true });
    const res = await admin({ action: 'pull', tenant_id: TENANT, period: '2026-09', preview_hash: previewHash, confirm: true }, client);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'preview_required', String(previewHash));
    assert.equal(client.queries.some((q) => /tenant_maintenance_payments/.test(q.sql)), false);
  }
  const badPeriod = await admin({ action: 'pull', tenant_id: TENANT, period: '2026-13', preview_hash: HASH, confirm: true }, fakeClient({ owner: true }));
  assert.equal(badPeriod.error, 'invalid_billing_period');
  // The engine itself requires the hash, so an older handler cannot charge without a preview.
  const direct = await chargeTenantPeriod(fakeClient({ owner: true }), { tenantId: TENANT, period: '2026-09', deps: { ignoreEnabledFlag: true } });
  assert.equal(direct.error, 'preview_required');
});

test('an unset destination refuses the charge before any lock, booking or provider call', async () => {
  await withEnv({ AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: undefined, AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: undefined }, async () => {
    const client = fakeClient({ owner: true });
    const res = await admin({ action: 'pull', tenant_id: TENANT, period: '2026-09', preview_hash: HASH, confirm: true }, client);
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.error, 'billing_destination_unresolved');
    assert.equal(res.charged, false);
    assert.equal(client.queries.some((q) => /pg_advisory|INSERT INTO public\.tenant_maintenance_payments|record_billing_audit/.test(q.sql)), false);
    const destination = await resolveBillingDestination(fakeClient(), { environment: 'sandbox' });
    assert.equal(destination.reason, 'destination_not_configured');
  });
});

test('the destination is the ChecksOps platform account: pins per environment, never a tenant account, never from a tenant request', async () => {
  // sandbox: only the ChecksOps sandbox merchant
  assert.equal(normalizeDest({ moov_account_id: TENANT, moov_payment_method_id: USER }, 'sandbox').reason, 'sandbox_destination_must_be_checksops_merchant');
  assert.equal(normalizeDest({ moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: USER }, 'sandbox').ok, true);
  // production: only the platform account and its wallet payment method
  assert.equal(normalizeDest({ moov_account_id: TENANT, moov_payment_method_id: USER }, 'production').ok, false);
  assert.equal(normalizeDest({ moov_account_id: CHECKSOPS_PLATFORM_ACCOUNT_ID, moov_payment_method_id: USER }, 'production').reason, 'destination_not_checksops_wallet_pm');
  assert.equal(normalizeDest({ moov_account_id: CHECKSOPS_PLATFORM_ACCOUNT_ID, moov_payment_method_id: CHECKSOPS_PLATFORM_WALLET_PM_ID }, 'production').ok, true);
  assert.equal(normalizeDest({ moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: USER }, 'production').ok, false);

  // set: a tenant's Moov account is refused even when it passes the shape checks
  const tenantOwned = {
    queries: [],
    query: async (sql, params) => {
      tenantOwned.queries.push(String(sql));
      if (/payment_provider_accounts/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
  const refused = await setBillingDestination(tenantOwned, {
    environment: 'sandbox', accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: USER,
  });
  assert.equal(refused.error, 'destination_is_tenant_account');
  assert.equal(tenantOwned.queries.some((sql) => /INSERT INTO public\.platform_billing_destination/.test(sql)), false);
  for (const [accountId, paymentMethodId, error] of [
    ['not-a-uuid', USER, 'invalid_destination_account_id'],
    [CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, '', 'invalid_destination_payment_method_id'],
  ]) {
    assert.equal((await setBillingDestination(fakeClient(), { environment: 'sandbox', accountId, paymentMethodId })).error, error);
  }

  // The tenant-facing authorize path never writes or returns the platform ids.
  const src = read('aws/functions/api/tenant-billing-handlers.mjs');
  const authorize = src.slice(src.indexOf('export const handleTenantBillingAuthorize'));
  assert.doesNotMatch(authorize, /setBillingDestination|platform_billing_destination/);
  assert.match(authorize, /destination = owner \? data\.destination : \{ configured: dest\.ok === true \}/);
});

test('no unattended charge: the scheduler entry points refuse with manual_billing_only and nothing sets the job GUC', async () => {
  let clients = 0;
  const scheduled = await handleMonthlyBillingScheduled({ body: '{}' }, {
    createClient: () => { clients += 1; return fakeClient(); },
    client: fakeClient(),
    ignoreEnabledFlag: true,
  });
  assert.equal(scheduled.statusCode, 410);
  assert.equal(scheduled.error, MANUAL_BILLING_ONLY);
  assert.equal(scheduled.liveProviderCalled, false);
  assert.equal(clients, 0);
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true' }, async () => {
    const engine = await runMonthlyBillingScheduler(fakeClient(), { deps: { ignoreEnabledFlag: true } });
    assert.equal(engine.error, MANUAL_BILLING_ONLY);
  });
  const api = fs.readdirSync(path.join(ROOT, 'aws/functions/api'), { recursive: true })
    .filter((f) => String(f).endsWith('.mjs') && !String(f).includes('node_modules'));
  for (const file of api) {
    const text = fs.readFileSync(path.join(ROOT, 'aws/functions/api', String(file)), 'utf8');
    assert.doesNotMatch(text, /set_config\('request\.monthly_billing_job'/, String(file));
  }
  // Nothing schedules a billing run.
  assert.doesNotMatch(read('aws/functions/api/scheduled.mjs'), /billing/i);
  for (const tpl of ['aws/template.yaml', 'aws/production/api-template.yaml', 'aws/production/api-cfn.yaml']) {
    assert.doesNotMatch(read(tpl), /MonthlyBilling|handleMonthlyBillingScheduled/i, tpl);
  }
});

test('the production post flags stay unset in the templates', () => {
  for (const tpl of ['aws/template.yaml', 'aws/production/api-template.yaml', 'aws/production/api-cfn.yaml']) {
    const text = read(tpl);
    for (const flag of [
      'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST', 'AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED',
      'AWS_MOOV_MONTHLY_BILLING_ENABLED', 'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
    ]) {
      assert.equal(text.includes(flag), false, `${tpl} ${flag}`);
    }
  }
});

test('production never books a simulated charge or $1 verification while the post flags are off', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: undefined,
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: undefined,
    AWS_MOOV_MONTHLY_BILLING_SIMULATE: 'true',
  }, async () => {
    const engine = await import('../functions/api/tenant-billing-engine.mjs');
    const src = read('aws/functions/api/tenant-billing-engine.mjs');
    assert.match(src, /environment === 'production' && !monthlyBillingProductionPostEnabled\(\) && deps\.simulate !== true/);
    assert.match(src, /environment === 'production' && !billingVerificationPostEnabled\(\) && deps\.simulate !== true/);
    assert.equal(typeof engine.verifyTenantBillingDebit, 'function');
  });
});

test('moov-tenant-fee-charge is retired: 410 use_tenant_billing_pull before identity, DB or provider work', async () => {
  assert.equal((await tenantFeeCharge.run({})).error, 'use_tenant_billing_pull');
  let touched = 0;
  const res = await MOOV_PARITY_HANDLERS['moov-tenant-fee-charge'](
    { body: JSON.stringify({ tenant_id: TENANT, amount_cents: 100 }) },
    { loadSandboxCredentials: async () => { touched += 1; return {}; }, createClient: () => { touched += 1; return fakeClient(); } },
  );
  assert.equal(res.statusCode, 410);
  assert.equal(res.error, 'use_tenant_billing_pull');
  assert.equal(res.liveProviderCalled, false);
  assert.equal(touched, 0);
  assert.match(read('supabase/functions/moov-tenant-fee-charge/index.ts'), /use_tenant_billing_pull[\s\S]*410/);
  assert.doesNotMatch(read('supabase/functions/moov-tenant-fee-charge/index.ts'), /moovFetch|tenant_maintenance_payments/);
});

test('the SPA charge buttons preview, confirm and pull through tenant-billing-admin, never with a browser amount', () => {
  const page = read('src/pages/admin/AdminTenants.tsx');
  assert.doesNotMatch(page, /moov-tenant-fee-charge/);
  assert.match(page, /<TenantFeeCollectButton/);
  assert.match(page, /<TenantBillingVerifyButton/);
  assert.match(page, /<PlatformFeeDestinationCard/);
  const lib = read('src/lib/tenantFeeBilling.ts');
  const pull = lib.slice(lib.indexOf('export const pullTenantFees'), lib.indexOf('export const verifyTenantBillingDebit'));
  assert.match(pull, /action: "pull"/);
  assert.match(pull, /preview_hash: previewHash/);
  assert.match(pull, /confirm: true/);
  assert.doesNotMatch(pull, /amount_cents|amount:|line_items/);
  const dialog = read('src/components/admin/TenantFeeCollection.tsx');
  assert.match(dialog, /previewTenantFees\(tenantId, period\)/);
  assert.match(dialog, /pullTenantFees\(tenantId, preview\.period, preview\.preview_hash\)/);
});

test('one per-check default, sourced from check_billing_config; the engine has no $4 constant', () => {
  const src = read('aws/functions/api/tenant-billing-engine.mjs');
  assert.doesNotMatch(src, /DEFAULT_CHECK_RATE_CENTS|(?<!statusCode: )\b[34]00\b/);
  assert.match(CHECK_BILLING_DEFAULT_PRICE_SQL, /FROM public\.check_billing_config\s+WHERE active = true/);
  // Same rule as SQL 98 record_check_billing_event().
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: true, per_check_rate_cents: 250 }, 300), 250);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: true, per_check_rate_cents: 0 }, 300), 0);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: true, per_check_rate_cents: null }, 300), 300);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: false, per_check_rate_cents: 250 }, 300), 300);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: false }, null), null);
  const sql = read('aws/workflows/sql/98_tenant_fee_collection.sql');
  assert.match(sql, /v_enabled IS TRUE AND v_rate IS NOT NULL/);
  assert.match(sql, /public\.aws_check_billing_default_price_cents\(\)/);
});

test('the preview hash covers amount, booked row and every line', () => {
  const invoice = {
    amount_cents: 1300,
    maintenance_net_cents: 1000,
    lines: { checks: [{ id: 'e1', unit_price_cents: 300 }], next_day: [], same_day: [], mortgage_ops_initial: [], mortgage_ops_additional: [] },
  };
  const base = billingPreviewHash({ tenantId: TENANT, period: '2026-09', invoice, occurrence: null });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, billingPreviewHash({ tenantId: TENANT, period: '2026-09', invoice: { ...invoice }, occurrence: null }));
  const variants = [
    { tenantId: USER, period: '2026-09', invoice, occurrence: null },
    { tenantId: TENANT, period: '2026-10', invoice, occurrence: null },
    { tenantId: TENANT, period: '2026-09', invoice: { ...invoice, amount_cents: 1301 }, occurrence: null },
    { tenantId: TENANT, period: '2026-09', invoice: { ...invoice, lines: { ...invoice.lines, checks: [{ id: 'e1', unit_price_cents: 400 }] } }, occurrence: null },
    { tenantId: TENANT, period: '2026-09', invoice, occurrence: { id: 'o1', amount_cents: 1300 } },
  ];
  for (const v of variants) assert.notEqual(billingPreviewHash(v), base);
});

test('the preview hash also binds the fee destination and the tenant funding source', () => {
  const invoice = {
    amount_cents: 1300,
    maintenance_net_cents: 1000,
    authorization: { provider_payment_method_id: 'pm-bank-a' },
    lines: { checks: [], next_day: [], same_day: [], mortgage_ops_initial: [], mortgage_ops_additional: [] },
  };
  const dest = { ok: true, accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: USER };
  const base = billingPreviewHash({ tenantId: TENANT, period: '2026-09', invoice, occurrence: null, destination: dest });
  assert.equal(base, billingPreviewHash({ tenantId: TENANT, period: '2026-09', invoice: { ...invoice }, occurrence: null, destination: { ...dest } }));
  for (const changed of [
    { destination: { ...dest, paymentMethodId: TENANT } },
    { destination: { ...dest, accountId: CHECKSOPS_PLATFORM_ACCOUNT_ID } },
    { destination: { ok: false, error: 'billing_destination_unresolved' } },
    { destination: null },
    { invoice: { ...invoice, authorization: { provider_payment_method_id: 'pm-bank-b' } } },
    { invoice: { ...invoice, authorization: null } },
  ]) {
    assert.notEqual(
      billingPreviewHash({ tenantId: TENANT, period: '2026-09', invoice, occurrence: null, destination: dest, ...changed }),
      base,
      JSON.stringify(changed),
    );
  }
});

test('only positive safe-integer cents are chargeable', () => {
  for (const ok of [1, 100, 9900, Number.MAX_SAFE_INTEGER]) assert.equal(isChargeableCents(ok), true, String(ok));
  for (const bad of [0, -1, 12.5, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined]) {
    assert.equal(isChargeableCents(bad), false, String(bad));
  }
  const src = read('aws/functions/api/tenant-billing-engine.mjs');
  const pull = src.slice(src.indexOf('export async function chargeTenantPeriod'), src.indexOf('export async function runMonthlyBillingScheduler'));
  assert.match(pull, /!isChargeableCents\(readiness\.amountCents\)\) readiness\.reasons\.push\('invalid_amount_cents'\)/);
  const preview = src.slice(src.indexOf('export async function previewTenantPeriodCharge'), src.indexOf('const legTransferIds'));
  assert.match(preview, /!isChargeableCents\(amountCents\)\) reasons\.push\('invalid_amount_cents'\)/);
});

test('a fee pull is bank-only: the tenant wallet is never debited, even with funds in it', async () => {
  const run = async (bankOnly) => {
    const posts = [];
    const result = await collectTenantObligation(null, {
      occurrence: { id: 'occ-1', tenant_id: TENANT, billing_period: '2026-09', amount_cents: 5000 },
      readiness: { environment: 'sandbox', authorization: { tenant_id: TENANT, provider_payment_method_id: 'pm-bank' } },
      destination: { accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: USER },
      deps: {
        bankOnly,
        simulate: true,
        wallet: {
          id: 'w1', tenant_id: TENANT, provider_account_id: 'acct-t', provider_wallet_id: 'wallet-t',
          provider_payment_method_id: 'pm-wallet', available_cents: 10000, pending_cents: 0,
        },
      },
      postTransfer: async ({ sourceMethodId, amount, idempotencyKey }) => {
        posts.push({ sourceMethodId, amount });
        return { transferID: `tr-${idempotencyKey}`, status: 'pending' };
      },
      resolveBillingDebitSource: async () => ({ ok: true, sourceMethodId: 'debit-pm-bank', sourceAccountId: 'acct-t' }),
    });
    return { result, posts };
  };
  const bank = await run(true);
  assert.equal(bank.result.ok, true, JSON.stringify(bank.result));
  assert.deepEqual(bank.posts, [{ sourceMethodId: 'debit-pm-bank', amount: 5000 }]);
  assert.equal(bank.result.wallet_applied_cents, 0);
  // Without bankOnly the shared collector would take the wallet first; the fee pull always passes it.
  const walletFirst = await run(false);
  assert.equal(walletFirst.posts[0].sourceMethodId, 'pm-wallet');
  const src = read('aws/functions/api/tenant-billing-engine.mjs');
  const pull = src.slice(src.indexOf('export async function chargeTenantPeriod'), src.indexOf('export async function runMonthlyBillingScheduler'));
  assert.match(pull, /submitOccurrence\(client, \{[\s\S]*?deps: \{ \.\.\.deps, bankOnly: true \}/);
});

test('the $1 verification debit uses the same bank-source rules as a pull', async () => {
  const occurrence = { id: 'v-occ', tenant_id: TENANT, status: 'due', idempotence_key: `billing-verify:${TENANT}:${USER}` };
  const authorization = { tenant_id: TENANT, provider_payment_method_id: 'pm-bank', provider_account_id: 'acct-t', provider_environment: 'sandbox' };
  const destination = { ok: true, environment: 'sandbox', accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, paymentMethodId: USER };
  await withEnv({ AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'true', AWS_MOOV_BILLING_VERIFICATION_SIMULATE: undefined }, async () => {
    for (const [debit, error, env] of [
      [{ ok: true, sourceMethodId: 'debit', sourceAccountId: CHECKSOPS_PLATFORM_ACCOUNT_ID }, 'platform_chase_used_as_source', 'sandbox'],
      [{ ok: true, sourceMethodId: USER, sourceAccountId: 'acct-t' }, 'source_destination_reversal', 'sandbox'],
      [{ ok: true, sourceMethodId: 'debit', sourceAccountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID }, 'sandbox_resource_in_production', 'production'],
    ]) {
      const client = fakeClient({ owner: true });
      const res = await submitVerificationOccurrence(client, {
        occurrence,
        readiness: { environment: env, authorization },
        destination,
        deps: { simulate: false, verificationId: USER, resolveBillingDebitSource: async () => debit },
      });
      assert.equal(res.ok, false, error);
      assert.equal(res.error, error);
      assert.equal(res.liveProviderCalled, false);
      assert.equal(client.queries.some((q) => /UPDATE public\.tenant_maintenance_payments/.test(q.sql)), false, error);
    }
    const crossTenant = await submitVerificationOccurrence(fakeClient({ owner: true }), {
      occurrence,
      readiness: { environment: 'sandbox', authorization: { ...authorization, tenant_id: USER } },
      destination,
      deps: { simulate: false, resolveBillingDebitSource: async () => ({ ok: true, sourceMethodId: 'debit', sourceAccountId: 'acct-t' }) },
    });
    assert.equal(crossTenant.error, 'cross_tenant_bank');
  });
});

test('open owner questions are isolated defaults, unchanged until the owner answers', async () => {
  // (a) fee destination: the platform Moov wallet, not owner-confirmed; one object every pin reads.
  assert.ok(Object.isFrozen(PRODUCTION_FEE_DESTINATION));
  assert.deepEqual(PRODUCTION_FEE_DESTINATION, {
    kind: 'platform_moov_wallet',
    accountId: CHECKSOPS_PLATFORM_ACCOUNT_ID,
    paymentMethodId: CHECKSOPS_PLATFORM_WALLET_PM_ID,
    ownerConfirmed: false,
  });
  assert.equal(assertExplicitDestination(PRODUCTION_FEE_DESTINATION, 'production').ok, true);
  assert.equal(normalizeDest({ moov_account_id: PRODUCTION_FEE_DESTINATION.accountId, moov_payment_method_id: PRODUCTION_FEE_DESTINATION.paymentMethodId }, 'production').ok, true);
  const collection = read('aws/functions/api/tenant-collection-v2.mjs');
  const assertFn = collection.slice(collection.indexOf('export function assertExplicitDestination'), collection.indexOf('export function assertTenantWalletSource'));
  assert.match(assertFn, /PRODUCTION_FEE_DESTINATION\.accountId/);
  assert.match(assertFn, /PRODUCTION_FEE_DESTINATION\.paymentMethodId/);
  assert.doesNotMatch(assertFn, /CHECKSOPS_PLATFORM_ACCOUNT_ID|CHECKSOPS_PLATFORM_WALLET_PM_ID/);
  await withEnv({ CHECKSOPS_ENV: 'production-prep', AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: undefined, AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: undefined }, async () => {
    const { billingDestinationStatus } = await import('../functions/api/tenant-billing-destination.mjs');
    const status = await billingDestinationStatus(fakeClient(), { environment: 'production' });
    assert.equal(status.production_destination_kind, 'platform_moov_wallet');
    assert.equal(status.production_destination_owner_confirmed, false);
  });

  // (b) per-check billing off still bills the config default; one switch in the API and one in SQL 98.
  assert.equal(PER_CHECK_OFF_BILLS_DEFAULT_PRICE, true);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: false }, 300), 300);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: false }, 300, { perCheckOffBillsDefault: false }), 0);
  assert.equal(resolveCheckRateCents({ per_check_billing_enabled: true, per_check_rate_cents: 250 }, 300, { perCheckOffBillsDefault: false }), 250);
  const sql = read('aws/workflows/sql/98_tenant_fee_collection.sql');
  assert.match(sql, /FUNCTION public\.aws_check_billing_charges_when_per_check_off\(\)[\s\S]*?AS \$\$ SELECT true \$\$;/);
  assert.match(sql, /ELSIF v_enabled IS NOT TRUE AND NOT public\.aws_check_billing_charges_when_per_check_off\(\) THEN\s+-- [^\n]*\n\s+RETURN NEW;/);

  // (c) no invoice email after a pull, and nothing in the fee path sends one.
  assert.equal(INVOICE_EMAIL_AFTER_PULL, false);
  for (const file of ['aws/functions/api/tenant-billing-engine.mjs', 'aws/functions/api/tenant-billing-handlers.mjs']) {
    assert.doesNotMatch(read(file), /send-transactional-email|sendTransactionalEmail|sendEmail\(|SendEmailCommand|SESv2Client|SESClient|client-sesv?2?/, file);
  }
  assert.match(read('aws/functions/api/tenant-billing-engine.mjs'), /invoice_email_sent: false/);
});
