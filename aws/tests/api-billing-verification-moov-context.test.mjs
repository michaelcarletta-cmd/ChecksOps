import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  billingEnvironment,
  billingShouldSimulate,
  billingVerificationPostEnabled,
  billingVerificationShouldSimulate,
  monthlyBillingProductionPostEnabled,
  resolveBillingMoovContext,
} from '../functions/api/tenant-billing-destination.mjs';
import {
  BILLING_VERIFICATION_AMOUNT_CENTS,
  OCCURRENCE_KIND_VERIFICATION,
  billingVerificationIdempotencyKey,
  postTransfer,
  verifyTenantBillingDebit,
} from '../functions/api/tenant-billing-engine.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERIFY_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_METHOD = '7a78a544-340d-46fd-a4a4-228661374da7';
const SOURCE_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const DEST_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const DEST_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const PROD_DEST = {
  ok: true,
  accountId: DEST_ACCOUNT,
  paymentMethodId: DEST_METHOD,
  environment: 'production',
  source: 'explicit',
};
const PROD_KEY = 'prod-public-key-v3a';
const PROD_SECRET = 'prod-secret-key-v3a';
const SANDBOX_KEY = 'sandbox-public-key-v3a';
const SANDBOX_SECRET = 'sandbox-secret-key-v3a';

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

const makeStore = () => ({
  tenants: new Map([[TENANT, {
    id: TENANT, name: 'Freedom Adjustment', slug: 'freedom', subscription_status: 'active',
    monthly_rate_cents: 10000, referral_discount_cents: 500, is_founding_partner: true,
    per_check_rate_cents: 400, per_check_billing_enabled: true,
    next_day_rate_cents: 75, same_day_rate_cents: 100,
    mortgage_ops_initial_rate_cents: 1000, mortgage_ops_additional_rate_cents: 500,
  }]]),
  checkEvents: [],
  transfers: [],
  checks: new Map(),
  allocations: [],
  settings: new Map(),
  mortgageLaunch: {
    singleton: true, launched_at: '2020-01-01T00:00:00.000Z',
    environment: 'test', note: 'unit', created_at: '2020-01-01T00:00:00.000Z',
  },
  authorizations: new Map(),
  accounts: new Map([
    [`${TENANT}:production`, {
      provider_account_id: SOURCE_ACCOUNT, onboarding_status: 'active', can_ach_debit: true,
      can_send_payments: true, verification_status: 'verified', capabilities: {},
    }],
  ]),
  methods: new Map([
    [`${TENANT}:${SOURCE_METHOD}`, {
      id: 'row-freedom', tenant_id: TENANT, provider_account_id: SOURCE_ACCOUNT,
      provider_payment_method_id: SOURCE_METHOD, provider_bank_account_id: 'bank-4573',
      holder_name: 'Freedom Bank', last_four: '4573', verification_status: 'verified',
      connection_status: 'connected', environment: 'production', nickname: '4573', can_send: true,
    }],
  ]),
  occurrences: [],
  destination: {
    environment: 'production',
    moov_account_id: DEST_ACCOUNT,
    moov_payment_method_id: DEST_METHOD,
    label: 'ChecksOps production merchant',
    verified_at: new Date().toISOString(),
  },
  users: new Map([[OWNER, { email: 'checksopsadmin@gmail.com', tenant_id: null, role: 'platform' }]]),
});

const mockClient = (store) => ({
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('is_platform_owner()')) return { rows: [{ ok: true }] };
    if (text.includes('FROM public.tenants WHERE id')) {
      return { rows: store.tenants.get(params[0]) ? [store.tenants.get(params[0])] : [] };
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
    if (text.includes('FROM public.tenant_billing_accounts')) {
      return { rows: store.authorizations.get(params[0]) ? [store.authorizations.get(params[0])] : [] };
    }
    if (text.includes('INSERT INTO public.tenant_billing_accounts') || text.includes('UPDATE public.tenant_billing_accounts SET')) {
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
    if (text.includes('FROM public.mortgage_ops_billing_launch')) {
      return { rows: store.mortgageLaunch ? [store.mortgageLaunch] : [] };
    }
    if (text.includes('SELECT * FROM public.tenant_maintenance_payments') && text.includes('idempotence_key')) {
      return { rows: store.occurrences.filter((row) => row.idempotence_key === params[0]) };
    }
    if (text.includes('SELECT * FROM public.tenant_maintenance_payments') && text.includes('billing_period')) {
      return { rows: store.occurrences.filter((row) => row.tenant_id === params[0] && row.billing_period === params[1]) };
    }
    if (text.includes('INSERT INTO public.tenant_maintenance_payments')) {
      const row = {
        id: `occ-${store.occurrences.length + 1}`,
        tenant_id: params[0],
        amount_cents: params[1],
        monthly_rate_cents: text.includes('billing_verification') || params[params.length - 1] === OCCURRENCE_KIND_VERIFICATION
          ? 0 : params[2],
        discount_cents: text.includes("'due'") ? params[3] ?? 0 : 0,
        period_start: params[4] ?? null,
        period_end: params[5] ?? null,
        billing_period: params[6] ?? null,
        method: 'moov_ach',
        status: 'due',
        idempotence_key: params[7] ?? params[2],
        recorded_by: params[8] ?? params[3],
        notes: params[9] ?? params[4],
        funding_source_method_id: params[10] ?? params[5],
        destination_account_id: params[11] ?? params[6],
        destination_payment_method_id: params[12] ?? params[7],
        provider_environment: params[13] ?? params[8],
        occurrence_kind: params[params.length - 1],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (params[params.length - 1] === OCCURRENCE_KIND_VERIFICATION) {
        row.amount_cents = params[1];
        row.idempotence_key = params[2];
        row.recorded_by = params[3];
        row.notes = params[4];
        row.funding_source_method_id = params[5];
        row.destination_account_id = params[6];
        row.destination_payment_method_id = params[7];
        row.provider_environment = params[8];
        row.billing_period = null;
        row.period_start = null;
        row.period_end = null;
      }
      store.occurrences.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.tenant_maintenance_payments SET')) {
      const row = store.occurrences.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.status = params[1];
      row.provider_transfer_id = params[2] || row.provider_transfer_id || null;
      row.failure_reason = params[3] || null;
      if (params[1] === 'submitted') row.submitted_at = row.submitted_at || new Date().toISOString();
      return { rows: [row] };
    }
    if (text.includes('FROM public.check_billing_events')) return { rows: [] };
    if (text.includes('FROM public.payment_transfers')) return { rows: [] };
    if (text.includes('FROM public.tenant_invoice_allocations')) return { rows: [] };
    if (text.includes('INSERT INTO public.tenant_invoices') || text.includes('FROM public.tenant_invoices')) {
      return { rows: [] };
    }
    if (text.includes('pg_advisory_xact_lock') || text.includes('set_config')) return { rows: [{}] };
    return { rows: [] };
  },
});

const readyFreedom = async (client, store) => {
  const { saveBillingSettings, saveBillingAuthorization } = await import('../functions/api/tenant-billing-engine.mjs');
  await saveBillingSettings(client, {
    tenantId: TENANT,
    monthlyRateCents: 10000,
    referralDiscountCents: 500,
    billingEnabled: true,
    billingDay: 1,
    userId: OWNER,
  });
  await saveBillingAuthorization(client, {
    tenantId: TENANT, userId: OWNER, paymentMethodId: SOURCE_METHOD,
    autoDebitEnabled: true, authorized: true,
  });
};

const loadedSecrets = ({ production = true, sandbox = true } = {}) => ({
  secrets: {
    ...(production ? { MOOV_PUBLIC_KEY: PROD_KEY, MOOV_SECRET_KEY: PROD_SECRET, MOOV_ACCOUNT_ID: DEST_ACCOUNT } : {}),
    ...(sandbox ? {
      MOOV_SANDBOX_PUBLIC_KEY: SANDBOX_KEY,
      MOOV_SANDBOX_SECRET_KEY: SANDBOX_SECRET,
      MOOV_SANDBOX_PLATFORM_ACCOUNT_ID: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
    } : {}),
  },
  moov: sandbox ? {
    publicKey: SANDBOX_KEY,
    secretKey: SANDBOX_SECRET,
    platformAccountId: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
    origin: 'https://checksops.com',
    apiVersion: 'v2024.01.00',
  } : null,
});

const recordingFetch = () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const authorization = opts.headers?.Authorization || '';
    let basicKey = null;
    if (authorization.startsWith('Basic ')) {
      basicKey = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':')[0];
    }
    const body = typeof opts.body === 'string' ? (() => {
      try { return JSON.parse(opts.body); } catch { return opts.body; }
    })() : opts.body;
    calls.push({ url: String(url), method: opts.method || 'GET', basicKey, body });
    if (String(url).includes('/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'tok-v3a', expires_in: 300 }),
      };
    }
    if (String(url).includes('/transfers')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ transferID: 'tr-prod-not-sim', status: 'pending' }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { calls, fetchImpl };
};

const productionEnv = {
  CHECKSOPS_ENV: 'production-prep',
  AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true',
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
  AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'true',
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: DEST_ACCOUNT,
  AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: DEST_METHOD,
};

test('A production billing verification resolves production Moov context', async () => {
  resetMoovTokenCache();
  await withEnv(productionEnv, async () => {
    const resolved = await resolveBillingMoovContext({
      environment: 'production',
      deps: { loadSandboxCredentials: async () => loadedSecrets() },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.environment, 'production');
    assert.equal(resolved.moovContext.productionPublicKey, PROD_KEY);
    assert.equal(resolved.moovContext.sandboxPublicKey, null);
    const { calls, fetchImpl } = recordingFetch();
    const created = await postTransfer({
      sourceMethodId: SOURCE_METHOD,
      destMethodId: DEST_METHOD,
      amount: BILLING_VERIFICATION_AMOUNT_CENTS,
      description: 'ChecksOps billing verification $1.00',
      metadata: { checksops_kind: 'billing_verification' },
      idempotencyKey: billingVerificationIdempotencyKey(TENANT, VERIFY_ID),
      fetchImpl,
      facilitatorAccountId: DEST_ACCOUNT,
      environment: 'production',
      deps: { loadSandboxCredentials: async () => loadedSecrets() },
    });
    assert.equal(created.transferID, 'tr-prod-not-sim');
    const tokenCall = calls.find((row) => row.url.includes('/oauth2/token'));
    const transferCall = calls.find((row) => row.url.includes('/transfers') && row.method === 'POST');
    assert.equal(tokenCall.basicKey, PROD_KEY);
    assert.notEqual(tokenCall.basicKey, SANDBOX_KEY);
    assert.equal(transferCall.body.source.paymentMethodID, SOURCE_METHOD);
    assert.equal(transferCall.body.destination.paymentMethodID, DEST_METHOD);
    assert.equal(transferCall.body.amount.value, 100);
  });
});

test('B production context cannot silently fall back to sandbox', async () => {
  resetMoovTokenCache();
  await withEnv(productionEnv, async () => {
    const { calls, fetchImpl } = recordingFetch();
    await assert.rejects(() => postTransfer({
      sourceMethodId: SOURCE_METHOD,
      destMethodId: DEST_METHOD,
      amount: 100,
      facilitatorAccountId: DEST_ACCOUNT,
      environment: 'production',
      fetchImpl,
      deps: {
        moovContext: {
          environment: 'sandbox',
          sandboxPublicKey: SANDBOX_KEY,
          sandboxSecretKey: SANDBOX_SECRET,
          productionPublicKey: PROD_KEY,
          productionSecretKey: PROD_SECRET,
        },
      },
    }), /billing_moov_environment_mismatch|production_moov_refused_sandbox_fallback/);
    assert.equal(calls.length, 0);
  });
});

test('C missing production context fails closed before HTTP', async () => {
  resetMoovTokenCache();
  await withEnv(productionEnv, async () => {
    const missing = await resolveBillingMoovContext({
      environment: 'production',
      deps: { loadSandboxCredentials: async () => loadedSecrets({ production: false, sandbox: true }) },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'production_credentials_unavailable');
    const { calls, fetchImpl } = recordingFetch();
    await assert.rejects(() => postTransfer({
      sourceMethodId: SOURCE_METHOD,
      destMethodId: DEST_METHOD,
      amount: 100,
      facilitatorAccountId: DEST_ACCOUNT,
      environment: 'production',
      fetchImpl,
      deps: { loadSandboxCredentials: async () => loadedSecrets({ production: false, sandbox: true }) },
    }), /Production payment credentials are not configured/);
    assert.equal(calls.length, 0);
  });
});

test('staging refuses production Moov keys even when requested', async () => {
  resetMoovTokenCache();
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'true',
  }, async () => {
    const resolved = await resolveBillingMoovContext({
      environment: 'production',
      deps: { loadSandboxCredentials: async () => loadedSecrets() },
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.error, 'production_credentials_refused');
  });
});

test('D staging simulation makes no provider POST', async () => {
  resetMoovTokenCache();
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true',
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
  }, async () => {
    const store = makeStore();
    store.accounts.set(`${TENANT}:sandbox`, store.accounts.get(`${TENANT}:production`));
    store.methods.get(`${TENANT}:${SOURCE_METHOD}`).environment = 'sandbox';
    const client = mockClient(store);
    await readyFreedom(client, store);
    const { calls, fetchImpl } = recordingFetch();
    const verify = await verifyTenantBillingDebit(client, {
      tenantId: TENANT,
      verificationId: VERIFY_ID,
      recordedBy: OWNER,
      fetchImpl,
      deps: {
        destination: {
          ok: true,
          accountId: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
          paymentMethodId: 'pm-checksops-wallet',
          environment: 'sandbox',
          source: 'explicit',
        },
        loadSandboxCredentials: async () => loadedSecrets(),
      },
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.simulated, true);
    assert.equal(verify.liveProviderCalled, false);
    assert.match(String(verify.occurrence.provider_transfer_id), /^sim:/);
    assert.equal(calls.length, 0);
  });
});

test('E F G live verification keeps source, destination, and 100 cents', async () => {
  resetMoovTokenCache();
  await withEnv(productionEnv, async () => {
    const store = makeStore();
    const client = mockClient(store);
    await readyFreedom(client, store);
    const { calls, fetchImpl } = recordingFetch();
    const verify = await verifyTenantBillingDebit(client, {
      tenantId: TENANT,
      verificationId: VERIFY_ID,
      recordedBy: OWNER,
      fetchImpl,
      deps: {
        destination: PROD_DEST,
        loadSandboxCredentials: async () => loadedSecrets(),
      },
    });
    assert.equal(verify.ok, true);
    assert.equal(verify.simulated, false);
    assert.equal(verify.liveProviderCalled, true);
    assert.equal(verify.amount_cents, 100);
    assert.equal(verify.occurrence.amount_cents, 100);
    assert.equal(verify.occurrence.funding_source_method_id, SOURCE_METHOD);
    assert.equal(verify.occurrence.destination_account_id, DEST_ACCOUNT);
    assert.equal(verify.occurrence.destination_payment_method_id, DEST_METHOD);
    assert.equal(verify.occurrence.billing_period, null);
    assert.equal(verify.occurrence.occurrence_kind, OCCURRENCE_KIND_VERIFICATION);
    const transferCall = calls.find((row) => row.url.includes('/transfers') && row.method === 'POST');
    assert.equal(transferCall.body.source.paymentMethodID, SOURCE_METHOD);
    assert.equal(transferCall.body.destination.paymentMethodID, DEST_METHOD);
    assert.equal(transferCall.body.amount.value, BILLING_VERIFICATION_AMOUNT_CENTS);
    const tokenCall = calls.find((row) => row.url.includes('/oauth2/token'));
    assert.equal(tokenCall.basicKey, PROD_KEY);
  });
});

test('H I monthly POST stays independent and verification POST false blocks provider', async () => {
  resetMoovTokenCache();
  await withEnv({
    ...productionEnv,
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
  }, async () => {
    assert.equal(monthlyBillingProductionPostEnabled(), false);
    assert.equal(billingVerificationPostEnabled(), false);
    assert.equal(billingVerificationShouldSimulate(), true);
    assert.equal(billingEnvironment(), 'production');
    const store = makeStore();
    const client = mockClient(store);
    await readyFreedom(client, store);
    const { calls, fetchImpl } = recordingFetch();
    const verify = await verifyTenantBillingDebit(client, {
      tenantId: TENANT,
      verificationId: VERIFY_ID,
      recordedBy: OWNER,
      fetchImpl,
      deps: { destination: PROD_DEST, loadSandboxCredentials: async () => loadedSecrets() },
    });
    assert.equal(verify.simulated, true);
    assert.equal(verify.liveProviderCalled, false);
    assert.equal(billingShouldSimulate(), true);
    assert.equal(calls.length, 0);
  });
});

test('J verification idempotency remains unchanged', async () => {
  resetMoovTokenCache();
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_MOOV_MONTHLY_BILLING_ENABLED: 'true',
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
  }, async () => {
    const store = makeStore();
    store.accounts.set(`${TENANT}:sandbox`, store.accounts.get(`${TENANT}:production`));
    store.methods.get(`${TENANT}:${SOURCE_METHOD}`).environment = 'sandbox';
    const client = mockClient(store);
    await readyFreedom(client, store);
    const dest = {
      ok: true,
      accountId: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
      paymentMethodId: 'pm-checksops-wallet',
      environment: 'sandbox',
      source: 'explicit',
    };
    const first = await verifyTenantBillingDebit(client, {
      tenantId: TENANT, verificationId: VERIFY_ID, recordedBy: OWNER,
      deps: { destination: dest },
    });
    const replay = await verifyTenantBillingDebit(client, {
      tenantId: TENANT, verificationId: VERIFY_ID, recordedBy: OWNER,
      deps: { destination: dest },
    });
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.duplicate, true);
    assert.equal(store.occurrences.length, 1);
    assert.equal(first.idempotency_key, billingVerificationIdempotencyKey(TENANT, VERIFY_ID));
    assert.equal(replay.idempotency_key, first.idempotency_key);
  });
});

test('K monthly billing behavior remains unchanged and shared postTransfer now binds context', async () => {
  const engine = readFileSync(path.join(ROOT, 'functions/api/tenant-billing-engine.mjs'), 'utf8');
  assert.match(engine, /withMoovContext/);
  assert.match(engine, /resolveBillingMoovContext/);
  assert.match(engine, /production_moov_refused_sandbox_fallback/);
  const dest = readFileSync(path.join(ROOT, 'functions/api/tenant-billing-destination.mjs'), 'utf8');
  assert.match(dest, /export async function resolveBillingMoovContext/);
  assert.match(dest, /production_credentials_refused/);
  assert.equal(dest.includes('MOOV_PUBLIC_KEY || secrets.MOOV_SANDBOX_PUBLIC_KEY'), false);
  await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: 'false',
    AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: 'false',
  }, () => {
    assert.equal(monthlyBillingProductionPostEnabled(), false);
    assert.equal(billingVerificationPostEnabled(), false);
  });
});
