import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  billingShouldSimulate,
  normalizeDest,
  resolveBillingDestination,
} from '../functions/api/tenant-billing-destination.mjs';
import {
  applyBillingProviderEvent,
  billingIdempotencyKey,
  chargeTenantPeriod,
  createOrGetOccurrence,
  evaluateBillingReadiness,
  netFeeCents,
  periodKey,
  runMonthlyBillingScheduler,
  saveBillingAuthorization,
  saveBillingSettings,
} from '../functions/api/tenant-billing-engine.mjs';
import {
  handleMonthlyBillingScheduled,
  handleTenantBillingAdmin,
  handleTenantBillingAuthorize,
} from '../functions/api/tenant-billing-handlers.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { handleScheduledRequest } from '../functions/api/scheduled.mjs';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEST = {
  accountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  paymentMethodId: 'pm-checksops-wallet',
  source: 'explicit',
};

const withEnv = async (vars, fn) => {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const identityEvent = (userId, body, email = 'checksopsadmin@gmail.com') => ({
  headers: { authorization: 'Bearer test' },
  body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { sub: userId, email } } } },
});

const makeStore = () => ({
  tenants: new Map([
    [TENANT_A, {
      id: TENANT_A, name: 'Tenant A', slug: 'a', subscription_status: 'active',
      monthly_rate_cents: 10000, referral_discount_cents: 0, is_founding_partner: false,
    }],
    [TENANT_B, {
      id: TENANT_B, name: 'Tenant B', slug: 'b', subscription_status: 'active',
      monthly_rate_cents: 7500, referral_discount_cents: 1500, is_founding_partner: true,
    }],
  ]),
  settings: new Map(),
  authorizations: new Map(),
  accounts: new Map([
    [`${TENANT_A}:sandbox`, {
      provider_account_id: 'acct-a', onboarding_status: 'active', can_ach_debit: true,
      can_send_payments: true, verification_status: 'verified', capabilities: {},
    }],
    [`${TENANT_B}:sandbox`, {
      provider_account_id: 'acct-b', onboarding_status: 'active', can_ach_debit: true,
      can_send_payments: true, verification_status: 'verified', capabilities: {},
    }],
  ]),
  methods: new Map([
    [`${TENANT_A}:pm-a`, {
      id: 'row-a', tenant_id: TENANT_A, provider_account_id: 'acct-a',
      provider_payment_method_id: 'pm-a', provider_bank_account_id: 'bank-a',
      holder_name: 'Tenant A Bank', last_four: '1111', verification_status: 'verified',
      connection_status: 'connected', environment: 'sandbox', nickname: 'A checking', can_send: true,
    }],
    [`${TENANT_B}:pm-b`, {
      id: 'row-b', tenant_id: TENANT_B, provider_account_id: 'acct-b',
      provider_payment_method_id: 'pm-b', provider_bank_account_id: 'bank-b',
      holder_name: 'Tenant B Bank', last_four: '2222', verification_status: 'verified',
      connection_status: 'connected', environment: 'sandbox', nickname: 'B checking', can_send: true,
    }],
  ]),
  occurrences: [],
  destination: {
    environment: 'sandbox',
    moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
    moov_payment_method_id: 'pm-checksops-wallet',
    label: 'ChecksOps merchant',
    verified_at: new Date().toISOString(),
  },
  users: new Map([
    [OWNER, { email: 'checksopsadmin@gmail.com', tenant_id: null, role: 'platform' }],
    [STAFF, { email: 'staff-a@example.com', tenant_id: TENANT_A, role: 'owner' }],
  ]),
});

const mockClient = (store, { platformOwner = true, actorTenant = TENANT_A, actorRole = 'owner' } = {}) => ({
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('is_platform_owner()')) return { rows: [{ ok: platformOwner }] };
    if (text.includes('FROM public.tenant_users')) {
      const user = store.users.get(params[0]);
      if (user && user.tenant_id === params[1]) return { rows: [{ role: user.role }] };
      if (!platformOwner && params[0] === STAFF && params[1] === actorTenant) {
        return { rows: [{ role: actorRole }] };
      }
      return { rows: [] };
    }
    if (text.includes('FROM public.tenants WHERE id')) {
      return { rows: store.tenants.get(params[0]) ? [store.tenants.get(params[0])] : [] };
    }
    if (text.includes('UPDATE public.tenants SET')) {
      const tenant = store.tenants.get(params[params.length - 1]);
      if (text.includes('monthly_rate_cents') && text.includes('referral_discount_cents')) {
        tenant.monthly_rate_cents = params[0];
        tenant.referral_discount_cents = params[1];
      } else if (text.includes('monthly_rate_cents')) tenant.monthly_rate_cents = params[0];
      else if (text.includes('referral_discount_cents')) tenant.referral_discount_cents = params[0];
      return { rows: [tenant] };
    }
    if (text.includes('FROM public.tenant_billing_settings')) {
      return { rows: store.settings.get(params[0]) ? [store.settings.get(params[0])] : [] };
    }
    if (text.includes('INSERT INTO public.tenant_billing_settings')) {
      const row = store.settings.get(params[0]) || {
        tenant_id: params[0], billing_enabled: false, billing_day_of_month: 1, next_period_start: null,
      };
      if (params[1] !== null && params[1] !== undefined) row.billing_enabled = params[1] === true;
      if (params[2] != null) row.billing_day_of_month = params[2];
      store.settings.set(params[0], row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.tenant_billing_settings')) {
      const row = store.settings.get(params[0]);
      if (row) row.next_period_start = params[1];
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM public.tenant_billing_accounts')) {
      return { rows: store.authorizations.get(params[0]) ? [store.authorizations.get(params[0])] : [] };
    }
    if (text.includes('INSERT INTO public.tenant_billing_accounts') || text.includes('UPDATE public.tenant_billing_accounts SET')) {
      if (text.includes('auto_debit_enabled = false')) {
        const row = store.authorizations.get(params[0]);
        if (row) row.auto_debit_enabled = false;
        return { rows: row ? [row] : [] };
      }
      const row = {
        id: store.authorizations.get(params[0])?.id || `auth-${params[0]}`,
        tenant_id: params[0],
        account_holder_name: params[1],
        account_number_last4: params[2],
        auto_debit_enabled: params[3],
        ach_authorized_at: params[4],
        ach_authorized_by: params[5],
        verification_status: params[6],
        provider_payment_method_id: params[7],
        provider_bank_account_id: params[8],
        provider_account_id: params[9],
        provider_environment: params[10],
        nickname: params[11],
      };
      store.authorizations.set(params[0], row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      return { rows: store.accounts.get(`${params[0]}:${params[1]}`) ? [store.accounts.get(`${params[0]}:${params[1]}`)] : [] };
    }
    if (text.includes('FROM public.payment_provider_methods')) {
      if (text.includes("connection_status = 'connected'")) {
        return {
          rows: [...store.methods.values()].filter((row) => (
            row.tenant_id === params[0] && row.environment === params[1]
          )),
        };
      }
      const key = `${params[0]}:${params[1]}`;
      return { rows: store.methods.get(key) ? [store.methods.get(key)] : [] };
    }
    if (text.includes('FROM public.platform_billing_destination')) {
      return { rows: store.destination && store.destination.environment === params[0] ? [store.destination] : [] };
    }
    if (text.includes('SELECT * FROM public.tenant_maintenance_payments') && text.includes('billing_period')) {
      return { rows: store.occurrences.filter((row) => row.tenant_id === params[0] && row.billing_period === params[1]) };
    }
    if (text.includes('WHERE provider_transfer_id')) {
      return { rows: store.occurrences.filter((row) => row.provider_transfer_id === params[0]) };
    }
    if (text.includes('INSERT INTO public.tenant_maintenance_payments')) {
      const existing = store.occurrences.find((row) => row.tenant_id === params[0] && row.billing_period === params[6]);
      if (existing) return { rows: [existing] };
      const row = {
        id: `occ-${store.occurrences.length + 1}`,
        tenant_id: params[0],
        amount_cents: params[1],
        monthly_rate_cents: params[2],
        discount_cents: params[3],
        period_start: params[4],
        period_end: params[5],
        billing_period: params[6],
        method: 'moov_ach',
        status: 'due',
        idempotence_key: params[7],
        recorded_by: params[8],
        notes: params[9],
        funding_source_method_id: params[10],
        destination_account_id: params[11],
        destination_payment_method_id: params[12],
        provider_environment: params[13],
        provider_transfer_id: null,
        submitted_at: null,
        settled_at: null,
        returned_at: null,
        failure_reason: null,
        return_reason: null,
        created_at: new Date().toISOString(),
      };
      store.occurrences.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.tenant_maintenance_payments SET') && text.includes('provider_transfer_id')) {
      const row = store.occurrences.find((item) => item.id === params[0]);
      row.status = params[1];
      row.provider_transfer_id = params[2] || row.provider_transfer_id;
      row.failure_reason = params[3];
      if (params[1] === 'submitted') row.submitted_at = row.submitted_at || new Date().toISOString();
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.tenant_maintenance_payments SET') && text.includes('settled_at')) {
      const row = store.occurrences.find((item) => item.id === params[0]);
      row.status = params[1];
      if (params[1] === 'settled') row.settled_at = row.settled_at || new Date().toISOString();
      if (params[1] === 'returned') {
        row.returned_at = row.returned_at || new Date().toISOString();
        row.return_reason = params[2] || row.return_reason;
      }
      if (params[1] === 'failed' || params[1] === 'returned') row.failure_reason = params[2] || row.failure_reason;
      return { rows: [row] };
    }
    if (text.includes('FROM public.tenant_maintenance_payments') && text.includes('ORDER BY')) {
      return {
        rows: store.occurrences
          .filter((row) => row.tenant_id === params[0])
          .sort((a, b) => String(b.billing_period).localeCompare(String(a.billing_period))),
      };
    }
    if (text.includes('JOIN public.tenant_billing_settings')) {
      const today = params[0];
      const day = Number(String(today).slice(8, 10));
      const due = [];
      for (const [tenantId, tenant] of store.tenants.entries()) {
        const settings = store.settings.get(tenantId);
        if (!settings || tenant.subscription_status !== 'active' || settings.billing_enabled !== true) continue;
        if (settings.next_period_start && settings.next_period_start > today) continue;
        if (settings.billing_day_of_month > day) continue;
        due.push({ tenant_id: tenantId });
      }
      return { rows: due };
    }
    if (text.includes('set_config')) return { rows: [] };
    return { rows: [] };
  },
});

const readyTenant = async (client, store, tenantId, paymentMethodId) => {
  await saveBillingSettings(client, {
    tenantId, monthlyRateCents: store.tenants.get(tenantId).monthly_rate_cents,
    referralDiscountCents: store.tenants.get(tenantId).referral_discount_cents,
    billingEnabled: true, billingDay: 1, userId: OWNER,
  });
  await saveBillingAuthorization(client, {
    tenantId, userId: OWNER, paymentMethodId, autoDebitEnabled: true, authorized: true,
  });
};

test('class A registry includes monthly billing functions and not money-movement jobs', () => {
  assert.ok(CLASS_A_FUNCTIONS.has('tenant-billing-admin'));
  assert.ok(CLASS_A_FUNCTIONS.has('tenant-billing-authorize'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-disburse'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-sweep'));
});

test('destination fails closed without explicit ChecksOps merchant ids', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: undefined,
    AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: undefined,
  }, async () => {
    const unresolved = await resolveBillingDestination(null, { environment: 'sandbox' });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.error, 'billing_destination_unresolved');
    const wrong = normalizeDest({
      moov_account_id: '00000000-0000-4000-8000-000000000000',
      moov_payment_method_id: 'pm-other',
    }, 'sandbox');
    assert.equal(wrong.ok, false);
    const prodSandbox = normalizeDest({
      moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
      moov_payment_method_id: 'pm-wallet',
    }, 'production');
    assert.equal(prodSandbox.ok, false);
    const ok = normalizeDest({
      moov_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
      moov_payment_method_id: 'pm-checksops-wallet',
      source: 'explicit',
    }, 'sandbox');
    assert.equal(ok.ok, true);
    assert.equal(ok.accountId, CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID);
    assert.equal(ok.paymentMethodId, 'pm-checksops-wallet');
  });
});

test('staging simulates unless sandbox transfer-post is explicitly enabled', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: undefined,
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: undefined,
  }, () => {
    assert.equal(billingShouldSimulate(), true);
  });
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: undefined,
  }, () => {
    assert.equal(billingShouldSimulate(), true);
  });
});

test('readiness fails closed for paused, inactive, missing auth, disconnected bank, and zero amount', async () => {
  const store = makeStore();
  const client = mockClient(store);
  const dest = { ok: true, ...DEST };
  const paused = await evaluateBillingReadiness(client, { tenantId: TENANT_A, destination: dest, environment: 'sandbox' });
  assert.equal(paused.ready, false);
  assert.ok(paused.reasons.includes('billing_paused'));
  assert.ok(paused.reasons.includes('missing_authorization'));

  store.tenants.get(TENANT_A).subscription_status = 'inactive';
  store.tenants.get(TENANT_A).monthly_rate_cents = 0;
  store.settings.set(TENANT_A, { tenant_id: TENANT_A, billing_enabled: true, billing_day_of_month: 1 });
  const inactive = await evaluateBillingReadiness(client, { tenantId: TENANT_A, destination: dest, environment: 'sandbox' });
  assert.ok(inactive.reasons.includes('tenant_inactive'));
  assert.ok(inactive.reasons.includes('invalid_amount'));

  store.tenants.get(TENANT_A).subscription_status = 'active';
  store.tenants.get(TENANT_A).monthly_rate_cents = 10000;
  store.authorizations.set(TENANT_A, {
    auto_debit_enabled: true, ach_authorized_at: new Date().toISOString(),
    provider_payment_method_id: 'pm-a', provider_account_id: 'acct-a',
  });
  store.methods.get(`${TENANT_A}:pm-a`).connection_status = 'disconnected';
  const disconnected = await evaluateBillingReadiness(client, { tenantId: TENANT_A, destination: dest, environment: 'sandbox' });
  assert.ok(disconnected.reasons.includes('bank_disconnected'));
});

test('tenant A and tenant B snapshot different rates and discounts onto unique period occurrences', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    await readyTenant(client, store, TENANT_B, 'pm-b');
    const period = '2026-09';
    const a = await chargeTenantPeriod(client, { tenantId: TENANT_A, period, recordedBy: OWNER, deps: { destination: { ok: true, ...DEST } } });
    const b = await chargeTenantPeriod(client, { tenantId: TENANT_B, period, recordedBy: OWNER, deps: { destination: { ok: true, ...DEST } } });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.occurrence.amount_cents, 10000);
    assert.equal(b.occurrence.amount_cents, 6000);
    assert.equal(a.occurrence.destination_account_id, CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID);
    assert.equal(b.occurrence.destination_payment_method_id, 'pm-checksops-wallet');
    assert.equal(a.occurrence.funding_source_method_id, 'pm-a');
    assert.equal(b.occurrence.funding_source_method_id, 'pm-b');
    assert.equal(a.occurrence.idempotence_key, `billing:${TENANT_A}:${period}`);
    assert.notEqual(a.occurrence.id, b.occurrence.id);
  });
});

test('duplicate scheduler and timeout retry create one debit for the same tenant period', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    const period = '2026-09';
    const first = await chargeTenantPeriod(client, { tenantId: TENANT_A, period, deps: { destination: { ok: true, ...DEST } } });
    const second = await chargeTenantPeriod(client, { tenantId: TENANT_A, period, deps: { destination: { ok: true, ...DEST } } });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.reason, 'already_submitted');
    assert.equal(store.occurrences.length, 1);
    assert.equal(store.occurrences[0].provider_transfer_id, first.occurrence.provider_transfer_id);
    const booked = await createOrGetOccurrence(client, {
      tenantId: TENANT_A, period, readiness: { amountCents: 99999, rateCents: 99999, discountCents: 0, authorization: store.authorizations.get(TENANT_A), environment: 'sandbox' },
      destination: DEST,
    });
    assert.equal(booked.created, false);
    assert.equal(booked.occurrence.amount_cents, 10000);
  });
});

test('historical rate is preserved after a later monthly rate change', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    const first = await chargeTenantPeriod(client, { tenantId: TENANT_A, period: '2026-08', deps: { destination: { ok: true, ...DEST } } });
    store.tenants.get(TENANT_A).monthly_rate_cents = 20000;
    const again = await chargeTenantPeriod(client, { tenantId: TENANT_A, period: '2026-08', deps: { destination: { ok: true, ...DEST } } });
    assert.equal(first.occurrence.amount_cents, 10000);
    assert.equal(again.occurrence.amount_cents, 10000);
    const next = await chargeTenantPeriod(client, { tenantId: TENANT_A, period: '2026-09', deps: { destination: { ok: true, ...DEST } } });
    assert.equal(next.occurrence.amount_cents, 20000);
  });
});

test('failed debit and ACH return do not remain paid; duplicate and out-of-order webhooks are safe', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    const failed = await chargeTenantPeriod(client, {
      tenantId: TENANT_A, period: '2026-07',
      deps: { destination: { ok: true, ...DEST }, simulateResult: 'failed' },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.occurrence.status, 'failed');

    const submitted = await chargeTenantPeriod(client, {
      tenantId: TENANT_A, period: '2026-09',
      deps: { destination: { ok: true, ...DEST } },
    });
    const transferId = submitted.occurrence.provider_transfer_id;
    const settled = await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'transfer.completed' });
    assert.equal(settled.occurrence.status, 'settled');
    const duplicate = await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'transfer.completed' });
    assert.equal(duplicate.duplicate, true);
    const returned = await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'transfer.returned', reason: 'R01' });
    assert.equal(returned.occurrence.status, 'returned');
    assert.ok(returned.occurrence.returned_at);
    const lateComplete = await applyBillingProviderEvent(client, { providerTransferId: transferId, status: 'transfer.completed' });
    assert.equal(lateComplete.skipped, 'already_returned');
    assert.equal(store.occurrences.find((row) => row.billing_period === '2026-09').status, 'returned');
    const retryReturned = await chargeTenantPeriod(client, {
      tenantId: TENANT_A, period: '2026-09',
      deps: { destination: { ok: true, ...DEST } },
    });
    assert.equal(retryReturned.ok, true);
    assert.equal(retryReturned.duplicate, true);
    assert.equal(retryReturned.reason, 'already_returned');
    assert.equal(store.occurrences.find((row) => row.billing_period === '2026-09').status, 'returned');
    assert.equal(store.occurrences.filter((row) => row.billing_period === '2026-09').length, 1);
  });
});

test('webhook apply updates a billing occurrence even when no payment_transfers row exists', async () => {
  const store = makeStore();
  const client = mockClient(store);
  store.occurrences.push({
    id: 'occ-wh', tenant_id: TENANT_A, amount_cents: 10000, billing_period: '2026-09',
    status: 'submitted', provider_transfer_id: 'moov-transfer-1',
  });
  const result = await applyMoovWebhook(client, {
    type: 'transfer.completed',
    data: { transferID: 'moov-transfer-1', status: 'completed' },
  });
  assert.equal(result.applied, true);
  assert.ok(result.mutations.includes('tenant_maintenance_payments'));
  assert.equal(store.occurrences[0].status, 'settled');
});

test('scheduler charges only due enabled tenants and stays one-occurrence per period', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    await readyTenant(client, store, TENANT_B, 'pm-b');
    store.settings.get(TENANT_B).billing_enabled = false;
    const first = await runMonthlyBillingScheduler(client, {
      now: new Date('2026-09-15T12:00:00Z'),
      deps: { destination: { ok: true, ...DEST } },
    });
    assert.equal(first.due, 1);
    assert.equal(first.results[0].ok, true);
    const retry = await chargeTenantPeriod(client, {
      tenantId: TENANT_A,
      period: first.period,
      deps: { destination: { ok: true, ...DEST } },
    });
    const second = await runMonthlyBillingScheduler(client, {
      now: new Date('2026-09-15T12:00:00Z'),
      deps: { destination: { ok: true, ...DEST } },
    });
    assert.equal(store.occurrences.filter((row) => row.tenant_id === TENANT_A).length, 1);
    assert.equal(retry.duplicate, true);
    assert.equal(second.due, 0);
  });
});

test('platform-owner admin path is required; tenant A cannot debit tenant B', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', AWS_SCHEDULED_JOB_SECRET: 'cron' }, async () => {
    const store = makeStore();
    const ownerClient = mockClient(store, { platformOwner: true });
    const staffClient = mockClient(store, { platformOwner: false, actorTenant: TENANT_A, actorRole: 'admin' });
    const denied = await handleTenantBillingAdmin(identityEvent(STAFF, { action: 'pull', tenant_id: TENANT_B }, 'staff-a@example.com'), {
      client: staffClient,
      mapping: { application_user_id: STAFF },
    });
    assert.equal(denied.error, 'platform_owner_required');
    const cross = await handleTenantBillingAuthorize(identityEvent(STAFF, {
      tenant_id: TENANT_B, provider_payment_method_id: 'pm-b',
    }, 'staff-a@example.com'), {
      client: staffClient,
      mapping: { application_user_id: STAFF },
    });
    assert.equal(cross.error, 'not_authorized');
    await readyTenant(ownerClient, store, TENANT_A, 'pm-a');
    const pull = await handleTenantBillingAdmin(identityEvent(OWNER, { action: 'pull', tenant_id: TENANT_A }), {
      client: ownerClient,
      mapping: { application_user_id: OWNER },
      destination: { ok: true, ...DEST },
    });
    assert.equal(pull.ok, true);
    assert.equal(pull.idempotency_key, billingIdempotencyKey(TENANT_A, periodKey()));
  });
});

test('scheduled job is narrow, secret-gated, and not in the disabled financial set', async () => {
  await withEnv({ AWS_SCHEDULED_JOB_SECRET: 'cron', AWS_MOOV_MONTHLY_BILLING_ENABLED: 'false' }, async () => {
    const unauthorized = await handleScheduledRequest({ headers: {}, body: JSON.stringify({ job: 'moov-monthly-tenant-billing' }) }, '/scheduled');
    assert.equal(unauthorized.statusCode, 401);
    const disabled = await handleScheduledRequest({
      headers: { 'x-scheduled-job-secret': 'cron' },
      body: JSON.stringify({ job: 'moov-monthly-tenant-billing' }),
    }, '/scheduled');
    assert.equal(disabled.error, 'monthly_billing_disabled');
    const treasury = await handleScheduledRequest({
      headers: { 'x-scheduled-job-secret': 'cron' },
      body: JSON.stringify({ job: 'platform-treasury' }),
    }, '/scheduled');
    assert.equal(treasury.error, 'financial_job_disabled');
  });
  const scheduled = readFileSync(path.join(ROOT, 'functions/api/scheduled.mjs'), 'utf8');
  assert.match(scheduled, /moov-monthly-tenant-billing/);
  assert.equal(/'moov-monthly-tenant-billing'/.test(scheduled.split('FINANCIAL_JOBS')[1].split(']')[0]), false);
});

test('sandbox readiness accepts pending collect-funds and incomplete onboarding', async () => {
  const store = makeStore();
  store.accounts.set(`${TENANT_A}:sandbox`, {
    provider_account_id: 'acct-a',
    onboarding_status: 'verification_pending',
    can_ach_debit: false,
    can_send_payments: true,
    verification_status: 'pending',
    capabilities: [{ capability: 'collect-funds', status: 'pending' }],
  });
  store.settings.set(TENANT_A, { tenant_id: TENANT_A, billing_enabled: true, billing_day_of_month: 1 });
  store.authorizations.set(TENANT_A, {
    auto_debit_enabled: true,
    ach_authorized_at: new Date().toISOString(),
    provider_payment_method_id: 'pm-a',
    provider_account_id: 'acct-a',
  });
  const ready = await evaluateBillingReadiness(mockClient(store), {
    tenantId: TENANT_A,
    destination: { ok: true, ...DEST },
    environment: 'sandbox',
  });
  assert.equal(ready.ready, true);
  store.accounts.set(`${TENANT_A}:sandbox`, {
    provider_account_id: 'acct-a',
    onboarding_status: 'suspended',
    can_ach_debit: false,
    capabilities: [{ capability: 'collect-funds', status: 'pending' }],
  });
  const suspended = await evaluateBillingReadiness(mockClient(store), {
    tenantId: TENANT_A,
    destination: { ok: true, ...DEST },
    environment: 'sandbox',
  });
  assert.ok(suspended.reasons.includes('moov_account_inactive'));
});

test('admin apply-event moves a simulated occurrence submitted to settled then returned', async () => {
  await withEnv({ AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true', CHECKSOPS_ENV: 'staging' }, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyTenant(client, store, TENANT_A, 'pm-a');
    const pull = await handleTenantBillingAdmin(identityEvent(OWNER, { action: 'pull', tenant_id: TENANT_A }), {
      client,
      mapping: { application_user_id: OWNER },
      destination: { ok: true, ...DEST },
    });
    assert.equal(pull.ok, true);
    assert.equal(pull.pull.occurrence.status, 'submitted');
    const transferId = pull.pull.occurrence.provider_transfer_id;
    const settled = await handleTenantBillingAdmin(identityEvent(OWNER, {
      action: 'apply-event', tenant_id: TENANT_A, provider_transfer_id: transferId, status: 'transfer.completed',
    }), {
      client,
      mapping: { application_user_id: OWNER },
      destination: { ok: true, ...DEST },
    });
    assert.equal(settled.ok, true);
    assert.equal(settled.event.occurrence.status, 'settled');
    const returned = await handleTenantBillingAdmin(identityEvent(OWNER, {
      action: 'apply-event', tenant_id: TENANT_A, provider_transfer_id: transferId, status: 'transfer.returned',
    }), {
      client,
      mapping: { application_user_id: OWNER },
      destination: { ok: true, ...DEST },
    });
    assert.equal(returned.ok, true);
    assert.equal(returned.event.occurrence.status, 'returned');
    assert.equal(returned.event.occurrence.provider_transfer_id, transferId);
    assert.equal(store.occurrences.length, 1);
  });
});

test('schema SQL is additive and unique on tenant plus billing period', () => {
  const sql = readFileSync(path.join(ROOT, 'rls/sql/43_moov_monthly_tenant_billing.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.tenant_billing_settings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.platform_billing_destination/);
  assert.match(sql, /tenant_maintenance_payments_tenant_period_uidx/);
  assert.match(sql, /billing_period/);
  assert.match(sql, /aws_can_authorize_tenant_billing/);
  assert.match(sql, /tenant_billing_accounts_bank_source_check/);
  assert.match(sql, /'due', 'settled'/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.checkalt/i);
});

test('net fee and idempotency identity are period-based', () => {
  assert.equal(netFeeCents(10000, 2500), 7500);
  assert.equal(netFeeCents(1000, 5000), 0);
  assert.equal(billingIdempotencyKey(TENANT_A, '2026-09'), `billing:${TENANT_A}:2026-09`);
});
