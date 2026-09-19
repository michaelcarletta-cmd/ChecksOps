import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  MOOV_ENVIRONMENT_CHANGE_WARNING,
  SANDBOX_SETUP_REQUIRED,
  assertNoCrossEnvironmentObject,
  ignoreClientEnvironment,
  isKnownProductionMoovObject,
  normalizeMoovEnvironment,
  payoutOperationScope,
} from '../functions/api/providers/moov-environment.mjs';
import {
  handleMoovTenantEnvironment,
  tenantEnvironmentChangeAuthorized,
} from '../functions/api/providers/moov-tenant-environment.mjs';
import {
  createMemoryPayoutStore,
  fundingIdempotencyKey,
  orchestratePayout,
  payoutIdempotencyKey,
  payoutOperationIdFor,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { handleProductionMoovPayoutOrchestrate } from '../functions/api/providers/production/moov-payout-orchestrate.mjs';
import { hasProductionMoovHandler } from '../functions/api/providers/production/moov-dispatch.mjs';
import {
  productionMoovTransferPostEnabled,
  sandboxMoovTransferPostEnabled,
  transferPostEnabledForEnvironment,
} from '../functions/api/provider-flags.mjs';
import { webhookSecretForEnvironment } from '../functions/api/provider-secrets.mjs';
import { verifyMoovWebhookEnvironment } from '../functions/api/providers/webhooks.mjs';
import { applyProductionMoovWebhook } from '../functions/api/providers/webhook-apply-production.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';

const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const SANDBOX_TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SANDBOX_ACCOUNT = '11111111-2222-4333-8444-555555555555';
const SANDBOX_WALLET = '66666666-7777-4888-8999-000000000000';
const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('existing tenants.moov_environment is reused and write-allowlist cannot change it', () => {
  assert.equal(normalizeMoovEnvironment('production'), 'production');
  assert.equal(normalizeMoovEnvironment('sandbox'), 'sandbox');
  assert.equal(normalizeMoovEnvironment('other'), null);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('moov_environment'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('name'), true);
  assert.equal(hasProductionMoovHandler('moov-tenant-environment'), true);
  assert.equal(FUNCTION_BY_NAME['moov-tenant-environment'].class, 8);
  const sql = sourceOf('../providers/sql/77_moov_tenant_environment.sql');
  assert.match(sql, /tenants_moov_environment_chk/);
  assert.match(sql, /aws_moov_set_tenant_environment/);
  assert.doesNotMatch(sql, /UPDATE public\.tenants[\s\S]*moov_environment = 'sandbox'/);
  assert.doesNotMatch(sql, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
});

test('authorized roles and confirmation are required to switch environment', async () => {
  assert.equal(tenantEnvironmentChangeAuthorized({ isAdmin: true }), true);
  assert.equal(tenantEnvironmentChangeAuthorized({ role: 'owner' }), true);
  assert.equal(tenantEnvironmentChangeAuthorized({ role: 'admin' }), true);
  assert.equal(tenantEnvironmentChangeAuthorized({ role: 'manager' }), false);
  assert.equal(tenantEnvironmentChangeAuthorized({ role: 'viewer' }), false);
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push(sql);
      if (String(sql).includes('user_roles')) return { rows: [{ '?column?': 1 }] };
      if (String(sql).includes('tenant_users') || String(sql).includes('TENANT_MEMBERSHIP')) {
        return { rows: [{ tenant_id: FREEDOM, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (String(sql).includes('FROM public.tenants')) {
        return { rows: [{ id: FREEDOM, moov_allowlisted: true, moov_environment: 'production' }] };
      }
      if (String(sql).includes('aws_moov_set_tenant_environment')) {
        assert.equal(params[1], 'production');
        assert.equal(params[2], 'sandbox');
        return { rows: [{
          tenant_id: FREEDOM,
          before_environment: 'production',
          after_environment: 'sandbox',
          objects_migrated: false,
          changed_at: '2026-09-19T00:00:00.000Z',
        }] };
      }
      return { rows: [] };
    },
  };
  const read = await handleMoovTenantEnvironment({
    client,
    mapping: { application_user_id: '11111111-1111-4111-8111-111111111111' },
    body: { tenant_id: FREEDOM, environment: 'sandbox' },
    loadSecrets: async () => ({ MOOV_SANDBOX_PUBLIC_KEY: 'x', MOOV_SANDBOX_SECRET_KEY: 'y', MOOV_PUBLIC_KEY: 'p', MOOV_SECRET_KEY: 's' }),
  });
  assert.equal(read.ok, true);
  assert.equal(read.environment, 'production');
  assert.equal(read.objects_migrated, false);
  assert.deepEqual(read.client_environment_ignored, ['environment']);
  assert.equal(read.warning, MOOV_ENVIRONMENT_CHANGE_WARNING);
  assert.equal(read.credentials.sandbox.configured, true);
  assert.equal(read.credentials.production.configured, true);
  assert.equal(read.credentials.sandbox.publicKey, undefined);
  assert.equal(read.credentials.production.secretKey, undefined);

  const denied = await handleMoovTenantEnvironment({
    client,
    mapping: { application_user_id: '11111111-1111-4111-8111-111111111111' },
    body: { tenant_id: FREEDOM, next_environment: 'sandbox', confirm: true },
    loadSecrets: async () => ({}),
  });
  assert.equal(denied.error, 'expected_current_required');

  const switched = await handleMoovTenantEnvironment({
    client,
    mapping: { application_user_id: '11111111-1111-4111-8111-111111111111' },
    body: {
      tenant_id: FREEDOM,
      next_environment: 'sandbox',
      expected_current: 'production',
      confirm: true,
    },
    loadSecrets: async () => ({ MOOV_SANDBOX_PUBLIC_KEY: 'x', MOOV_SANDBOX_SECRET_KEY: 'y' }),
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.before, 'production');
  assert.equal(switched.after, 'sandbox');
  assert.equal(switched.objects_migrated, false);
  assert.equal(switched.productionMoneyMoved, false);
  assert.ok(queries.some((sql) => String(sql).includes('aws_moov_set_tenant_environment')));
});

test('cross-environment object spoof is refused and credentials stay isolated', () => {
  const sandboxSpoof = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  });
  assert.equal(sandboxSpoof.error, 'cross_environment_object_refused');
  const prodSpoof = assertNoCrossEnvironmentObject({
    environment: 'production',
    accountId: SANDBOX_ACCOUNT,
  });
  assert.equal(prodSpoof.error, 'cross_environment_object_refused');
  assert.equal(isKnownProductionMoovObject(KNOWN_APPROVED_MOOV.freedom.walletId), true);
  assert.equal(isKnownProductionMoovObject(SANDBOX_WALLET), false);
  assert.deepEqual(ignoreClientEnvironment({ environment: 'sandbox', env: 'production' }), ['environment', 'env']);
  assert.equal(productionMoovTransferPostEnabled(), false);
  assert.equal(sandboxMoovTransferPostEnabled(), false);
  assert.equal(transferPostEnabledForEnvironment('sandbox'), false);
  assert.equal(transferPostEnabledForEnvironment('production'), false);
  const secrets = {
    MOOV_WEBHOOK_SECRET: 'prod-secret',
    MOOV_SANDBOX_WEBHOOK_SECRET: 'sand-secret',
  };
  assert.equal(webhookSecretForEnvironment(secrets, 'moov', 'production'), 'prod-secret');
  assert.equal(webhookSecretForEnvironment(secrets, 'moov', 'sandbox'), 'sand-secret');
});

test('sandbox and production idempotency namespaces do not collide', async () => {
  const prodOp = payoutOperationIdFor({
    tenantId: FREEDOM,
    environment: 'production',
    recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
    payoutCents: 1,
  });
  const sandOp = payoutOperationIdFor({
    tenantId: SANDBOX_TENANT,
    environment: 'sandbox',
    recipientId: SANDBOX_ACCOUNT,
    payoutCents: 1,
  });
  assert.notEqual(prodOp, sandOp);
  assert.notEqual(
    fundingIdempotencyKey(prodOp, 1, 'production'),
    fundingIdempotencyKey(sandOp, 1, 'sandbox'),
  );
  assert.notEqual(
    payoutIdempotencyKey(prodOp, 1, 'production'),
    payoutIdempotencyKey(sandOp, 1, 'sandbox'),
  );
  assert.match(fundingIdempotencyKey(prodOp, 1, 'production'), /env:production/);
  assert.match(payoutOperationScope({
    tenantId: FREEDOM,
    environment: 'production',
    payoutOperationId: prodOp,
    leg: 'wallet_funding',
    amountCents: 1,
  }), new RegExp(FREEDOM));
});

const runScenario = async (overrides = {}) => orchestratePayout({
  availableCents: 0,
  payoutCents: 1,
  recipientVerified: true,
  persistMoneyIntents: true,
  transferPostEnabled: false,
  environment: 'sandbox',
  tenantId: SANDBOX_TENANT,
  store: createMemoryPayoutStore(),
  ...overrides,
});

test('sandbox scenarios 1-13: funded, short, pending, completed, failed, timeout, duplicate, recipient/bank', async () => {
  const funded = await runScenario({ availableCents: 1, persistMoneyIntents: false });
  assert.equal(funded.decision, 'PAYOUT_READY');
  assert.equal(funded.shortfall_cents, 0);
  assert.equal(funded.environment, 'sandbox');
  assert.equal(funded.funding_intent, null);

  const pennyShort = await runScenario({ availableCents: 0 });
  assert.equal(pennyShort.decision, 'FUND_FIRST');
  assert.equal(pennyShort.shortfall_cents, 1);
  assert.equal(pennyShort.funding_intent.amount_cents, 1);
  assert.equal(pennyShort.payout_intent.created, true);

  const partial = await runScenario({ availableCents: 50, payoutCents: 100 });
  assert.equal(partial.shortfall_cents, 50);
  assert.equal(partial.funding_intent.amount_cents, 50);

  const store = createMemoryPayoutStore();
  const first = await runScenario({ store });
  const duplicateClick = await runScenario({ store });
  assert.equal(duplicateClick.funding_intent.reused, true);
  assert.equal(duplicateClick.payout_intent.reused, true);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);

  const pendingStore = createMemoryPayoutStore({
    intents: {
      [first.funding_intent.idempotency_key]: {
        ...first.funding_intent,
        status: 'submitted',
      },
    },
  });
  const pending = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    transferPostEnabled: true,
    totpDisbursePresent: true,
    recipientVerified: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    store: pendingStore,
  });
  assert.equal(pending.funding_state, 'funding_submitted');
  assert.ok(pending.blocked_reasons.includes('funding_pending'));
  assert.equal(pending.may_create_second_funding, false);

  const fundedAfter = await runScenario({ availableCents: 1, persistMoneyIntents: false });
  assert.equal(fundedAfter.decision, 'PAYOUT_READY');
  assert.equal(fundedAfter.payout_state, 'payout_ready');

  const failPlan = await runScenario();
  const failStore = createMemoryPayoutStore({
    intents: {
      [failPlan.funding_intent.idempotency_key]: {
        ...failPlan.funding_intent,
        status: 'failed',
      },
    },
  });
  const failed = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    transferPostEnabled: true,
    recipientVerified: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    store: failStore,
  });
  assert.equal(failed.funding_state, 'funding_failed');
  assert.equal(failed.may_create_second_funding, false);

  const timeout = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    store: createMemoryPayoutStore(),
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: failPlan.payout_operation_id,
      idempotency_key: failPlan.funding_intent.idempotency_key,
      status: 'unknown',
    }],
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
  });
  assert.equal(timeout.funding_state, 'funding_unknown');

  const payoutPending = await orchestratePayout({
    availableCents: 1,
    payoutCents: 1,
    persistMoneyIntents: true,
    recipientVerified: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_disbursement',
      kind: 'wallet_disbursement',
      payout_operation_id: payoutOperationIdFor({
        tenantId: SANDBOX_TENANT,
        environment: 'sandbox',
        recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
        payoutCents: 1,
      }),
      status: 'submitted',
    }],
  });
  assert.equal(payoutPending.payout_state, 'payout_submitted');

  const payoutDone = await orchestratePayout({
    availableCents: 1,
    payoutCents: 1,
    persistMoneyIntents: false,
    recipientVerified: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_disbursement',
      kind: 'wallet_disbursement',
      payout_operation_id: payoutOperationIdFor({
        tenantId: SANDBOX_TENANT,
        environment: 'sandbox',
        recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
        payoutCents: 1,
      }),
      status: 'completed',
    }],
  });
  assert.equal(payoutDone.payout_state, 'payout_completed');
  assert.equal(payoutDone.ux_stage, 'payment_completed');

  const payoutFail = await orchestratePayout({
    availableCents: 1,
    payoutCents: 1,
    persistMoneyIntents: false,
    recipientVerified: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_disbursement',
      kind: 'wallet_disbursement',
      payout_operation_id: payoutOperationIdFor({
        tenantId: SANDBOX_TENANT,
        environment: 'sandbox',
        recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
        payoutCents: 1,
      }),
      status: 'failed',
    }],
  });
  assert.equal(payoutFail.payout_state, 'payout_failed');

  const noRecipient = await runScenario({ recipientVerified: false, persistMoneyIntents: false, availableCents: 1 });
  assert.ok(noRecipient.blocked_reasons.includes('recipient_not_verified'));
  assert.equal(noRecipient.payout_submittable, false);
});

test('sandbox scenarios 14-20: unavailable objects, spoof, sweep ignore, one fund+payout, env-scoped recon', async () => {
  const sweep = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    environment: 'sandbox',
    tenantId: SANDBOX_TENANT,
    store: createMemoryPayoutStore(),
    sweepActivity: [{ origin: 'provider_sweep', activity_kind: 'sweep_push', environment: 'sandbox' }],
    existingRows: [{
      environment: 'production',
      leg_role: 'wallet_funding',
      amount_cents: 1,
      status: 'completed',
      idempotency_key: 'prod-only',
    }],
  });
  assert.equal(sweep.sweep_used_as_funding, false);
  assert.equal(sweep.ignored_sweep_count, 1);
  assert.equal(sweep.funding_intent.created, true);
  assert.equal(sweep.payout_intent.created, true);
  assert.match(sweep.funding_intent.idempotency_key, /env:sandbox/);
  assert.doesNotMatch(sweep.funding_intent.idempotency_key, /env:production/);

  const handlerSetup = await handleProductionMoovPayoutOrchestrate({
    client: {
      query: async (sql) => {
        if (String(sql).includes('tenant_users') || String(sql).includes('TENANT_MEMBERSHIP')) {
          return { rows: [{ tenant_id: SANDBOX_TENANT, role: 'admin', tenant_name: 'Sandbox', tenant_slug: 'sandbox' }] };
        }
        if (String(sql).includes('FROM public.tenants')) {
          return { rows: [{ id: SANDBOX_TENANT, moov_allowlisted: true, moov_environment: 'sandbox' }] };
        }
        return { rows: [] };
      },
    },
    mapping: { application_user_id: 'user-1' },
    body: { tenant_id: SANDBOX_TENANT, environment: 'production' },
    fetchImpl: async () => { throw new Error('no_fetch'); },
    loadSecrets: async () => ({ ok: true, credentials: { environment: 'production' } }),
    loadSandboxSecrets: async () => ({ ok: true, credentials: { environment: 'sandbox' } }),
  });
  assert.equal(handlerSetup.error, 'sandbox_setup_required');
  assert.equal(handlerSetup.message, SANDBOX_SETUP_REQUIRED);
  assert.equal(handlerSetup.environment, 'sandbox');

  const spoofClient = {
    query: async (sql) => {
      if (String(sql).includes('tenant_users') || String(sql).includes('TENANT_MEMBERSHIP')) {
        return { rows: [{ tenant_id: SANDBOX_TENANT, role: 'admin', tenant_name: 'Sandbox', tenant_slug: 'sandbox' }] };
      }
      if (String(sql).includes('FROM public.tenants')) {
        return { rows: [{ id: SANDBOX_TENANT, moov_allowlisted: true, moov_environment: 'sandbox' }] };
      }
      if (String(sql).includes('FROM public.payment_provider_accounts')) {
        return { rows: [{ provider_account_id: KNOWN_APPROVED_MOOV.freedom.moovAccountId, environment: 'sandbox' }] };
      }
      if (String(sql).includes('FROM public.payment_wallets')) {
        return { rows: [{ provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId, available_cents: 0, environment: 'sandbox' }] };
      }
      return { rows: [] };
    },
  };
  const spoofed = await handleProductionMoovPayoutOrchestrate({
    client: spoofClient,
    mapping: { application_user_id: 'user-1' },
    body: { tenant_id: SANDBOX_TENANT },
    fetchImpl: async () => { throw new Error('no_fetch'); },
    loadSandboxSecrets: async () => ({ ok: true, credentials: { environment: 'sandbox' } }),
  });
  assert.equal(spoofed.error, 'cross_environment_object_refused');

  const observed = [];
  const recon = await applyProductionMoovWebhook({
    query: async (sql, params = []) => {
      observed.push({ sql, params });
      if (String(sql).includes('aws_moov_lookup_transfer')) {
        assert.equal(params[1], 'sandbox');
        return { rows: [] };
      }
      if (String(sql).includes('aws_moov_observe_provider_activity')) {
        assert.equal(params[11], 'sandbox');
        return { rows: [{ observed_id: 'obs-1', observed_transfer_id: params[1], observed_origin: 'provider_unknown', observed_status: 'pending' }] };
      }
      return { rows: [] };
    },
  }, {
    type: 'transfer.updated',
    data: { transferID: 'sandbox-transfer-1', status: 'pending' },
  }, { mappedTenantId: SANDBOX_TENANT, environment: 'sandbox' });
  assert.equal(recon.environment, 'sandbox');
  assert.equal(recon.createdPaymentTransfer, false);
  assert.ok(observed.some((row) => String(row.sql).includes('aws_moov_lookup_transfer')));
});

test('webhook signing environment is authoritative and duplicate webhooks do not mix ledgers', () => {
  const rawBody = JSON.stringify({ eventID: 'evt-1', accountID: SANDBOX_ACCOUNT });
  const ts = Math.floor(Date.now() / 1000);
  const sandboxSecret = 'sandbox-webhook';
  const productionSecret = 'production-webhook';
  const signed = hmacHex(sandboxSecret, `${ts}|nonce|evt-1`, 'sha512');
  const event = {
    headers: {
      'x-timestamp': String(ts),
      'x-nonce': 'nonce',
      'x-webhook-id': 'evt-1',
      'x-signature': signed,
    },
  };
  const verified = verifyMoovWebhookEnvironment({
    event,
    rawBody,
    secrets: {
      MOOV_WEBHOOK_SECRET: productionSecret,
      MOOV_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.environment, 'sandbox');
  const sql = sourceOf('../providers/sql/77_moov_tenant_environment.sql');
  assert.match(sql, /payment_provider_activity_provider_env_transfer_uniq/);
  assert.match(sql, /payment_webhook_events_provider_env_event_uniq/);
  assert.match(sql, /AND t\.environment = p_environment/);
});

test('UI shows confirmation warning and SANDBOX/Production badges; Freedom objects are not auto-switched', () => {
  const control = sourceOf('../../src/components/payments/MoovEnvironmentControl.tsx');
  const tenants = sourceOf('../../src/pages/admin/AdminTenants.tsx');
  const wallet = sourceOf('../../src/pages/WalletOps.tsx');
  const panel = sourceOf('../../src/components/settings/TenantPaymentAccountPanel.tsx');
  assert.match(control, /MOOV_ENVIRONMENT_CHANGE_WARNING/);
  assert.match(control, /moov-tenant-environment/);
  assert.match(control, /confirm: true/);
  assert.match(tenants, /MoovEnvironmentControl/);
  assert.doesNotMatch(tenants, /moov_environment: on \? "sandbox" : "production"/);
  assert.match(wallet, /MoovEnvironmentBadge/);
  assert.match(wallet, /SANDBOX_SETUP_REQUIRED/);
  assert.match(panel, /MoovEnvironmentControl/);
  assert.match(sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs'), /loadTenantMoovEnvironment/);
  assert.doesNotMatch(sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs'), /AWS_MOOV_TRANSFER_POST_ENABLED/);
  assert.match(sourceOf('../functions/api/provider-flags.mjs'), /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
});

test('Moov sandbox lifecycle: ACH is not assumed instant; wallet-wallet can be used when present', () => {
  const note = sourceOf('../functions/api/providers/production/moov-sandbox-client.mjs');
  assert.match(note, /Sandbox-only Moov GET/);
  assert.doesNotMatch(note, /accelerated settlement guaranteed/);
});
