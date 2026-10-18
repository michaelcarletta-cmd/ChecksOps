/**
 * Tenant management: every button works (API half).
 *  - tenant-billing-admin profile-update / member-remove (SQL 102 setters),
 *    platform owner only, with a readable message on every refusal;
 *  - pricing update clears a rate with JSON null and returns what was saved;
 *  - loadTenantBillingContext survives a missing column inside a transaction;
 *  - billing_not_ready and fee-destination refusals explain themselves
 *    (no environment variable names);
 *  - production Check Alt register replies carry per-field messages;
 *  - tenant-invite-resend is an app-services route.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BILLING_REASON_MESSAGES,
  SET_TENANT_PRICING_SQL,
  billingNotReadyMessage,
  loadTenantBillingContext,
  saveBillingSettings,
} from '../functions/api/tenant-billing-engine.mjs';
import {
  REMOVE_TENANT_MEMBER_SQL,
  SET_TENANT_PROFILE_SQL,
  TENANT_PROFILE_KEYS,
  handleTenantBillingAdmin,
} from '../functions/api/tenant-billing-handlers.mjs';
import {
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  billingDestinationStatus,
  resolveBillingDestination,
  setBillingDestination,
} from '../functions/api/tenant-billing-destination.mjs';
import { validateRegisterBody } from '../functions/api/providers/production/checkalt-register.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';
const MEMBER = 'b2000000-0000-4000-8000-000000000002';

const sqlError = (message, code, detail) => Object.assign(new Error(message), { code, detail });

/**
 * A transaction-shaped fake: after a failed statement every query but a
 * ROLLBACK (TO SAVEPOINT) fails with 25P02, like PostgreSQL.
 */
const txnClient = ({
  owner = true, profileError = null, removeError = null, tenantRow = null, failFullTenantSelect = false, pricingResult = null,
} = {}) => {
  const queries = [];
  let aborted = false;
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (aborted && !/^ROLLBACK/.test(text)) {
        throw sqlError('current transaction is aborted, commands ignored until end of transaction block', '25P02');
      }
      if (/^ROLLBACK TO SAVEPOINT/.test(text)) { aborted = false; return { rows: [] }; }
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner }] };
      if (text === SET_TENANT_PROFILE_SQL) {
        if (profileError) { aborted = true; throw profileError; }
        const profile = JSON.parse(params[1]);
        return { rows: [{ result: { ok: true, tenant_id: params[0], tenant: { id: params[0], slug: 'acme', ...profile } } }] };
      }
      if (text === REMOVE_TENANT_MEMBER_SQL) {
        if (removeError) { aborted = true; throw removeError; }
        return { rows: [{ result: { ok: true, tenant_id: params[0], user_id: params[1], removed: 1 } }] };
      }
      if (text === SET_TENANT_PRICING_SQL) {
        return { rows: [{ result: pricingResult || { ok: true, pricing: JSON.parse(params[1]) } }] };
      }
      if (/FROM public\.tenants WHERE id/.test(text)) {
        if (failFullTenantSelect && /deposits_enabled/.test(text)) {
          aborted = true;
          throw sqlError('column "deposits_enabled" does not exist', '42703');
        }
        return { rows: tenantRow ? [tenantRow] : [] };
      }
      return { rows: [] };
    },
  };
};

const admin = (client, body) => handleTenantBillingAdmin(
  { body: JSON.stringify(body) },
  { client, mapping: { application_user_id: USER } },
);

test('profile-update sends only the contract keys to SQL 102 and returns the saved tenant', async () => {
  const client = txnClient();
  const body = {
    action: 'profile-update',
    tenant_id: TENANT,
    name: 'Acme Roofing',
    custom_domain: null,
    subscription_status: 'active',
    max_checks_per_month: 250,
    is_test_account: true,
    kyc_status: 'approved',
    kyc_notes: 'ok',
    internal_notes: null,
    monthly_rate_cents: 1, // not a profile key: never forwarded
  };
  const res = await admin(client, body);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.tenant.name, 'Acme Roofing');
  const call = client.queries.find((q) => q.sql === SET_TENANT_PROFILE_SQL);
  assert.equal(call.params[0], TENANT);
  const sent = JSON.parse(call.params[1]);
  assert.deepEqual(Object.keys(sent).sort(), [...TENANT_PROFILE_KEYS].sort());
  assert.equal('monthly_rate_cents' in sent, false);
  assert.equal(client.queries.some((q) => /UPDATE public\.tenants/.test(q.sql)), false);
});

test('profile-update refuses slug and partner_code before any SQL, and an empty or invalid request', async () => {
  for (const key of ['slug', 'partner_code']) {
    const client = txnClient();
    const res = await admin(client, { action: 'profile-update', tenant_id: TENANT, name: 'X', [key]: 'new' });
    assert.equal(res.statusCode, 400, key);
    assert.equal(res.error, 'field_not_editable');
    assert.equal(res.message, 'The company URL (slug) and partner code are permanent.');
    assert.equal(client.queries.some((q) => q.sql === SET_TENANT_PROFILE_SQL), false, key);
  }
  const empty = await admin(txnClient(), { action: 'profile-update', tenant_id: TENANT });
  assert.equal(empty.error, 'missing_required_field');
  assert.ok(empty.message);
  const badTenant = await admin(txnClient(), { action: 'profile-update', tenant_id: 'acme', name: 'X' });
  assert.equal(badTenant.error, 'invalid_uuid');
  assert.ok(badTenant.message);
});

test('profile-update maps every SQL 102 refusal to a readable message', async () => {
  const cases = [
    [sqlError('field_not_editable', '22023', 'slug'), 400, 'field_not_editable', /permanent/],
    [sqlError('invalid_value', '22023', 'max_checks_per_month'), 400, 'invalid_value', /^Monthly check limit has an invalid value\.$/],
    [sqlError('invalid_field', '22023', 'plan_tier'), 400, 'invalid_field', /cannot be edited/],
    [sqlError('column_not_present', '22023', 'kyc_notes'), 400, 'column_not_present', /KYC notes/],
    [sqlError('moov_environment_locked', '55000', 'is_test_account'), 409, 'moov_environment_locked', /connected payment account, so test mode can't be changed/],
    [sqlError('value_in_use', '23505', 'custom_domain'), 409, 'custom_domain_in_use', /already used by another company/],
    [sqlError('function public.aws_platform_owner_set_tenant_profile(uuid, jsonb) does not exist', '42883'), 503, 'profile_setter_missing', /SQL 102/],
    [sqlError('not_authorized: platform owner required', '42501'), 403, 'platform_owner_required', /platform owner/],
    [sqlError('tenant_not_found', 'P0002'), 404, 'tenant_not_found', /not found/],
  ];
  for (const [error, statusCode, code, message] of cases) {
    const res = await admin(txnClient({ profileError: error }), { action: 'profile-update', tenant_id: TENANT, name: 'X' });
    assert.equal(res.ok, false, code);
    assert.equal(res.statusCode, statusCode, code);
    assert.equal(res.error, code);
    assert.match(res.message, message, code);
  }
});

test('member-remove calls the SQL 102 remover; bad ids and refusals are readable', async () => {
  const client = txnClient();
  const res = await admin(client, { action: 'member-remove', tenant_id: TENANT, user_id: MEMBER });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.removed, 1);
  const call = client.queries.find((q) => q.sql === REMOVE_TENANT_MEMBER_SQL);
  assert.deepEqual(call.params, [TENANT, MEMBER]);

  const bad = await admin(txnClient(), { action: 'member-remove', tenant_id: TENANT, user_id: 'x' });
  assert.equal(bad.error, 'invalid_uuid');
  assert.equal(bad.field, 'user_id');
  assert.ok(bad.message);

  const missing = await admin(txnClient({ removeError: sqlError('membership_not_found', 'P0002') }), {
    action: 'member-remove', tenant_id: TENANT, user_id: MEMBER,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.error, 'membership_not_found');
  assert.match(missing.message, /not a member/);
});

test('profile-update and member-remove are platform owner only', async () => {
  for (const body of [
    { action: 'profile-update', tenant_id: TENANT, name: 'X' },
    { action: 'member-remove', tenant_id: TENANT, user_id: MEMBER },
  ]) {
    const client = txnClient({ owner: false });
    const res = await admin(client, body);
    assert.equal(res.statusCode, 403, body.action);
    assert.equal(res.error, 'platform_owner_required');
    assert.ok(res.message);
    assert.equal(client.queries.some((q) => q.sql === SET_TENANT_PROFILE_SQL || q.sql === REMOVE_TENANT_MEMBER_SQL), false);
  }
});

const TENANT_ROW = {
  id: TENANT,
  name: 'Acme',
  slug: 'acme',
  subscription_status: 'active',
  monthly_rate_cents: 9900,
  referral_discount_cents: 0,
  is_founding_partner: false,
  per_check_rate_cents: null,
  per_check_billing_enabled: false,
  next_day_rate_cents: null,
  same_day_rate_cents: 100,
};

test('loadTenantBillingContext falls back to the older column list without aborting the transaction', async () => {
  const client = txnClient({ tenantRow: TENANT_ROW, failFullTenantSelect: true });
  const ctx = await loadTenantBillingContext(client, TENANT);
  assert.equal(ctx.ok, true, JSON.stringify(ctx));
  assert.equal(ctx.tenant.name, 'Acme');
  const order = client.queries.map((q) => q.sql.split('\n')[0].trim());
  const savepoint = order.indexOf('SAVEPOINT tenant_billing_context');
  const rollback = order.indexOf('ROLLBACK TO SAVEPOINT tenant_billing_context');
  assert.ok(savepoint >= 0 && rollback > savepoint, order.join(' | '));
  // The later reads in the same transaction ran (no 25P02).
  assert.ok(client.queries.some((q) => /tenant_billing_settings/.test(q.sql)));
});

test('pricing update: JSON null clears a rate through SQL 96; the response carries the saved pricing and settings', async () => {
  const client = txnClient({
    tenantRow: TENANT_ROW,
    pricingResult: { ok: true, pricing: { per_check_rate_cents: null, next_day_rate_cents: null, monthly_rate_cents: 9900 } },
  });
  const saved = await saveBillingSettings(client, {
    tenantId: TENANT, userId: USER, perCheckRateCents: null, nextDayRateCents: null, monthlyRateCents: 9900,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const call = client.queries.find((q) => q.sql === SET_TENANT_PRICING_SQL);
  assert.deepEqual(JSON.parse(call.params[1]), {
    monthly_rate_cents: 9900, per_check_rate_cents: null, next_day_rate_cents: null,
  });
  assert.equal(saved.pricing.per_check_rate_cents, null);
  assert.equal(saved.pricing.next_day_rate_cents, null);
  assert.equal(saved.pricing.monthly_rate_cents, 9900);
  assert.equal(saved.pricing.same_day_rate_cents, 100);
  assert.deepEqual(saved.billing_settings, { billing_enabled: false, billing_day_of_month: 1 });

  // Undefined and '' leave a rate alone.
  const untouched = txnClient({ tenantRow: TENANT_ROW });
  await saveBillingSettings(untouched, { tenantId: TENANT, userId: USER, perCheckRateCents: '', monthlyRateCents: 100 });
  assert.deepEqual(JSON.parse(untouched.queries.find((q) => q.sql === SET_TENANT_PRICING_SQL).params[1]), { monthly_rate_cents: 100 });

  const res = await admin(txnClient({ tenantRow: TENANT_ROW }), {
    action: 'update', tenant_id: TENANT, per_check_rate_cents: null,
  });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 400));
  assert.equal(res.saved, true);
  assert.equal(res.pricing.per_check_rate_cents, null);
  assert.ok(res.billing_settings);

  const notNull = await saveBillingSettings(
    { query: async (sql) => { if (sql === SET_TENANT_PRICING_SQL) throw Object.assign(sqlError('null value', '23502'), { column: 'monthly_rate_cents' }); return { rows: [] }; } },
    { tenantId: TENANT, userId: USER, monthlyRateCents: null },
  );
  assert.equal(notNull.error, 'rate_required');
  assert.match(notNull.message, /cannot be cleared/);
});

test('billing_not_ready explains its reasons in a sentence; verify-debit keeps reasons and message', async () => {
  assert.match(billingNotReadyMessage(['billing_paused', 'missing_authorization']), /^Billing is not ready: billing is paused for this company; the company has not linked a bank account for billing\.$/);
  assert.equal(billingNotReadyMessage([]), 'Billing is not ready for this company yet.');
  for (const reason of Object.keys(BILLING_REASON_MESSAGES)) assert.doesNotMatch(BILLING_REASON_MESSAGES[reason], /_/);

  const client = txnClient({ tenantRow: TENANT_ROW });
  const res = await handleTenantBillingAdmin(
    { body: JSON.stringify({ action: 'verify-debit', tenant_id: TENANT, confirm: true, verification_id: MEMBER }) },
    {
      client,
      mapping: { application_user_id: USER },
      environment: 'sandbox',
      destination: { moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, moov_payment_method_id: MEMBER },
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.statusCode, 409);
  assert.equal(res.error, 'billing_not_ready');
  assert.ok(Array.isArray(res.reasons) && res.reasons.includes('billing_paused'), JSON.stringify(res.reasons));
  assert.match(res.message, /^Billing is not ready: /);
  assert.equal(res.charged, false);
});

test('fee destination refusals are owner-readable and never name environment variables', async () => {
  const saved = { account: process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID, method: process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID };
  delete process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID;
  delete process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID;
  try {
    const client = { query: async () => ({ rows: [] }) };
    const unresolved = await resolveBillingDestination(client, { environment: 'sandbox' });
    assert.equal(unresolved.error, 'billing_destination_unresolved');
    assert.equal(unresolved.reason, 'destination_not_configured');
    assert.match(unresolved.message, /not set up yet/);
    assert.doesNotMatch(unresolved.message, /AWS_|platform_billing_destination/);

    const status = await billingDestinationStatus(client, { environment: 'sandbox' });
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'destination_not_configured');
    assert.equal(status.message, unresolved.message);

    const wrong = await resolveBillingDestination(client, {
      environment: 'sandbox', deps: { destination: { moov_account_id: MEMBER, moov_payment_method_id: MEMBER } },
    });
    assert.equal(wrong.reason, 'sandbox_destination_must_be_checksops_merchant');
    assert.match(wrong.message, /sandbox account/);

    for (const [accountId, paymentMethodId, error] of [
      ['nope', MEMBER, 'invalid_destination_account_id'],
      [CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID, 'nope', 'invalid_destination_payment_method_id'],
    ]) {
      const res = await setBillingDestination(client, { environment: 'sandbox', accountId, paymentMethodId });
      assert.equal(res.error, error);
      assert.ok(res.message, error);
      assert.doesNotMatch(res.message, /AWS_/);
    }
  } finally {
    if (saved.account !== undefined) process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = saved.account;
    if (saved.method !== undefined) process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = saved.method;
  }
});

test('production Check Alt register: every invalid field reply has a message', () => {
  const good = {
    tenant_id: TENANT, sso_user_id: 'acme', first_name: 'A', last_name: 'B', email: 'a@b.example', deposit_account_number: '123456789',
  };
  assert.equal(validateRegisterBody(good).error, undefined);
  for (const [field, value] of [
    ['tenant_id', 'x'], ['sso_user_id', 'has space'], ['first_name', ''], ['last_name', ' '], ['email', 'nope'], ['deposit_account_number', '12-34'],
  ]) {
    const { error } = validateRegisterBody({ ...good, [field]: value });
    assert.ok(error, field);
    assert.equal(error.field, field);
    assert.ok(error.message && !/_/.test(error.message), `${field}: ${error.message}`);
  }
});

test('tenant-invite-resend is an app-services route (POST)', async () => {
  assert.equal(CLASS_A_FUNCTIONS.has('tenant-invite-resend'), true);
  const preflight = await handleAppServiceRequest({}, '/functions/v1/tenant-invite-resend', 'OPTIONS');
  assert.equal(preflight.statusCode, 200);
});
