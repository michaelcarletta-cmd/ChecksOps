import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyProductionMoovWebhook,
  reconcileExistingFromProviderGet,
  reconcileWalletCache,
} from '../functions/api/providers/webhook-apply-production.mjs';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';
import {
  canTransition,
  completedAtFor,
  extractTransferEvent,
  extractWalletEvent,
  needsParityFill,
} from '../functions/api/providers/moov-lifecycle.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const INTENT = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const TRANSFER = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const WALLET = PIPELINE_TEST_SANDBOX.walletId;
const COMPLETED_ON = '2026-09-21T04:16:07.540816Z';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PROD_WALLET = '3e6286ca-a19c-45f6-aad9-f73dac5f0358';

const completedPayload = {
  type: 'transfer.updated',
  eventID: 'm79i-completion',
  accountID: PIPELINE_TEST_SANDBOX.accountId,
  data: {
    transferID: TRANSFER,
    status: 'completed',
    completedOn: COMPLETED_ON,
    amount: { currency: 'USD', valueDecimal: '0.01' },
    source: {
      paymentMethodType: 'ach-debit-fund',
      achDetails: { completedOn: COMPLETED_ON, status: 'completed' },
    },
    destination: { paymentMethodType: 'moov-wallet' },
  },
};

const staleCompleted = {
  id: INTENT,
  tenant_id: PIPELINE,
  status: 'completed',
  environment: 'sandbox',
  amount_cents: 1,
  completed_at: null,
  provider_status: 'completed',
  provider_transfer_id: TRANSFER,
  leg_role: 'wallet_funding',
  failure_reason: 'moov_sandbox_http_failed',
};

const mockClient = ({
  lookup = staleCompleted,
  wallets = {
    sandbox: {
      id: 'rds-wallet-sandbox',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_wallet_id: WALLET,
      available_cents: 1,
      pending_cents: 0,
    },
  },
} = {}) => {
  const queries = [];
  const inserts = [];
  const eventLog = [
    {
      id: 'evt-403',
      event_type: 'moov.sandbox_http_failed',
      new_status: 'failed',
      provider_metadata: { failure_reason: 'moov_sandbox_http_failed', code: '403' },
    },
  ];
  return {
    queries,
    inserts,
    eventLog,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        inserts.push('payment_transfers');
        throw new Error('payment_transfers_insert_forbidden');
      }
      if (/DELETE\s+FROM\s+public\.payment_event_log/i.test(sql)) {
        throw new Error('event_log_delete_forbidden');
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('aws_moov_lookup_transfer')) {
        return { rows: lookup ? [lookup] : [] };
      }
      if (sql.includes('FROM public.payment_transfers') && !sql.includes('UPDATE')) {
        return { rows: lookup ? [{
          ...lookup,
          destination_recipient_id: lookup.destination_recipient_id ?? null,
          wallet_id: lookup.wallet_id ?? null,
          transfer_group_id: lookup.transfer_group_id ?? null,
          claim_id: lookup.claim_id ?? null,
          check_id: lookup.check_id ?? null,
          description: lookup.description ?? 'fund',
        }] : [] };
      }
      if (sql.includes('aws_moov_reconcile_existing_transfer')) {
        const nextFailure = params[1] === 'completed' ? null : lookup?.failure_reason || null;
        if (lookup) {
          lookup = {
            ...lookup,
            status: params[1],
            provider_status: params[2],
            completed_at: params[3] || lookup.completed_at,
            failure_reason: nextFailure,
          };
        }
        eventLog.push({
          id: `evt-recon-${eventLog.length}`,
          event_type: params[4],
          previous_status: params[5],
          new_status: params[1],
        });
        return {
          rows: [{
            id: lookup.id,
            status: lookup.status,
            provider_status: lookup.provider_status,
            completed_at: lookup.completed_at,
            tenant_id: lookup.tenant_id,
            failure_reason: lookup.failure_reason,
          }],
        };
      }
      if (sql.includes('aws_moov_reconcile_wallet_cache')) {
        const env = params[1];
        const walletId = params[0];
        const row = wallets[env];
        if (!row || row.provider_wallet_id !== walletId) {
          if (Object.values(wallets).some((w) => w.provider_wallet_id === walletId && w.environment !== env)) {
            const err = new Error('moov_environment_mismatch');
            throw err;
          }
          return { rows: [] };
        }
        if (params[4] && String(params[4]) !== String(row.tenant_id)) {
          throw new Error('moov_tenant_mismatch');
        }
        row.available_cents = params[2] ?? row.available_cents;
        row.pending_cents = params[3] ?? row.pending_cents;
        eventLog.push({ id: `evt-wallet-${eventLog.length}`, event_type: 'moov.wallet_cache_reconcile' });
        return { rows: [{ ...row }] };
      }
      if (sql.includes('aws_moov_observe_provider_activity')) {
        return { rows: [{ observed_id: 'obs-1', observed_transfer_id: params[1], origin: params[2], status: params[4] }] };
      }
      if (sql.includes('aws_moov_record_reconcile_event')) {
        eventLog.push({ id: `evt-skip-${eventLog.length}`, event_type: params[3] });
        return { rows: [] };
      }
      if (sql.includes('UPDATE public.payment_wallets')) {
        const envSandbox = sql.includes("environment = 'sandbox'");
        const envProd = sql.includes("environment = 'production'");
        const env = envSandbox ? 'sandbox' : (envProd ? 'production' : null);
        const row = env ? wallets[env] : null;
        if (!row || row.provider_wallet_id !== params[0]) return { rows: [] };
        row.available_cents = params[1] ?? row.available_cents;
        row.pending_cents = params[2] ?? row.pending_cents;
        return { rows: [{ ...row }] };
      }
      if (sql.includes('UPDATE public.payment_transfers')) {
        lookup = {
          ...lookup,
          status: params[1],
          provider_status: params[2],
          completed_at: params[3] || lookup.completed_at,
          failure_reason: params[1] === 'completed' ? null : (params[4] ?? lookup.failure_reason),
        };
        return { rows: [{ id: lookup.id }] };
      }
      return { rows: [] };
    },
  };
};

test('completed transfer sets completed_at from provider completedOn', async () => {
  const client = mockClient();
  const result = await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  assert.equal(result.applied, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed_at, COMPLETED_ON);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderCalled, false);
  const recon = client.queries.find((q) => q.sql.includes('aws_moov_reconcile_existing_transfer'));
  assert.ok(recon);
  assert.equal(recon.params[3], COMPLETED_ON);
  assert.equal(completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: COMPLETED_ON,
    existingCompletedAt: null,
  }), COMPLETED_ON);
});

test('completed transfer clears stale current failure_reason', async () => {
  const client = mockClient();
  const result = await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  assert.equal(result.failure_reason, null);
  assert.equal(needsParityFill(staleCompleted, extractTransferEvent(completedPayload)), true);
  const recon = client.queries.find((q) => q.sql.includes('aws_moov_reconcile_existing_transfer'));
  assert.equal(recon.params[1], 'completed');
});

test('historical failure and audit evidence remains preserved', async () => {
  const client = mockClient();
  const before = client.eventLog.map((row) => row.id);
  await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  assert.ok(client.eventLog.some((row) => row.id === 'evt-403'));
  assert.equal(client.eventLog.filter((row) => row.id === 'evt-403').length, 1);
  assert.ok(before.every((id) => client.eventLog.some((row) => row.id === id)));
  assert.equal(client.inserts.length, 0);
  const sql = sourceOf('../providers/sql/78_moov_recon_parity.sql');
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.payment_event_log/i);
  assert.match(sql, /cleared_failure_reason/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.payment_transfers/i);
});

test('sandbox balance event updates sandbox wallet cache only', async () => {
  const wallets = {
    sandbox: {
      id: 'rds-wallet-sandbox',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_wallet_id: WALLET,
      available_cents: 0,
      pending_cents: 0,
    },
    production: {
      id: 'rds-wallet-prod',
      tenant_id: PIPELINE,
      environment: 'production',
      provider_wallet_id: PROD_WALLET,
      available_cents: 99,
      pending_cents: 5,
    },
  };
  const client = mockClient({ lookup: null, wallets });
  const result = await applyProductionMoovWebhook(client, {
    type: 'balance.updated',
    eventID: 'm79i-balance-sandbox',
    accountID: PIPELINE_TEST_SANDBOX.accountId,
    data: {
      walletID: WALLET,
      availableBalance: { currency: 'USD', valueDecimal: '0.01' },
      pendingBalance: { currency: 'USD', value: 0 },
    },
  }, { mappedTenantId: PIPELINE, environment: 'sandbox' });
  assert.equal(result.applied, true);
  assert.equal(result.available_cents, 1);
  assert.equal(result.pending_cents, 0);
  assert.equal(result.environment, 'sandbox');
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(wallets.production.available_cents, 99);
  assert.equal(wallets.production.pending_cents, 5);
  const cache = client.queries.find((q) => q.sql.includes('aws_moov_reconcile_wallet_cache'));
  assert.equal(cache.params[1], 'sandbox');
  assert.equal(cache.params[0], WALLET);
});

test('production balance event updates production wallet only', async () => {
  const wallets = {
    sandbox: {
      id: 'rds-wallet-sandbox',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_wallet_id: WALLET,
      available_cents: 0,
      pending_cents: 0,
    },
    production: {
      id: 'rds-wallet-prod',
      tenant_id: FREEDOM,
      environment: 'production',
      provider_wallet_id: PROD_WALLET,
      available_cents: 0,
      pending_cents: 0,
    },
  };
  const client = mockClient({ lookup: null, wallets });
  const result = await applyProductionMoovWebhook(client, {
    type: 'walletTransaction.updated',
    eventID: 'm79i-balance-prod',
    accountID: '60922058-7eca-4889-81dd-5720d7b9de96',
    data: {
      walletID: PROD_WALLET,
      status: 'completed',
      availableBalance: { currency: 'USD', valueDecimal: '12.34' },
      pendingBalance: { currency: 'USD', value: 0 },
    },
  }, { mappedTenantId: FREEDOM, environment: 'production' });
  assert.equal(result.applied, true);
  assert.equal(result.environment, 'production');
  assert.equal(result.available_cents, 1234);
  assert.equal(wallets.sandbox.available_cents, 0);
  const cache = client.queries.find((q) => q.sql.includes('aws_moov_reconcile_wallet_cache'));
  assert.equal(cache.params[1], 'production');
  assert.equal(cache.params[0], PROD_WALLET);
});

test('cross-environment wallet update is rejected', async () => {
  const wallets = {
    sandbox: {
      id: 'rds-wallet-sandbox',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_wallet_id: WALLET,
      available_cents: 0,
      pending_cents: 0,
    },
  };
  const client = mockClient({ lookup: null, wallets });
  const result = await applyProductionMoovWebhook(client, {
    type: 'balance.updated',
    accountID: PIPELINE_TEST_SANDBOX.accountId,
    data: {
      walletID: WALLET,
      availableBalance: { currency: 'USD', value: 1 },
      pendingBalance: { currency: 'USD', value: 0 },
    },
  }, { mappedTenantId: PIPELINE, environment: 'production' });
  assert.equal(result.applied, false);
  assert.equal(result.skipped, 'cross_environment_wallet_refused');
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(wallets.sandbox.available_cents, 0);
  const direct = await reconcileWalletCache(client, {
    providerWalletId: WALLET,
    environment: 'production',
    availableCents: 1,
    pendingCents: 0,
    tenantId: PIPELINE,
  });
  assert.equal(direct.skipped, 'cross_environment_wallet_refused');
});

test('duplicate webhook remains idempotent after parity fill', async () => {
  const client = mockClient();
  const first = await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  const second = await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  assert.equal(first.applied, true);
  assert.equal(first.skipped, null);
  assert.equal(first.parity_fill, true);
  assert.equal(second.applied, true);
  assert.equal(second.skipped, 'idempotent_same_status');
  assert.equal(second.financialTablesMutated, false);
  assert.equal(client.queries.filter((q) => q.sql.includes('aws_moov_reconcile_existing_transfer')).length, 1);
});

test('terminal completed transfer cannot regress to pending', async () => {
  const filled = {
    ...staleCompleted,
    completed_at: COMPLETED_ON,
    failure_reason: null,
  };
  const client = mockClient({ lookup: filled });
  const result = await applyProductionMoovWebhook(client, {
    ...completedPayload,
    data: { ...completedPayload.data, status: 'pending' },
  }, { mappedTenantId: PIPELINE, environment: 'sandbox' });
  assert.equal(canTransition('completed', 'pending').ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.skipped, 'terminal_regression');
  assert.equal(result.status, 'completed');
  assert.equal(result.financialTablesMutated, false);
  assert.ok(!client.queries.some((q) => q.sql.includes('aws_moov_reconcile_existing_transfer')));
});

test('no provider POST occurs on webhook or GET recon', async () => {
  const client = mockClient();
  const webhook = await applyProductionMoovWebhook(client, completedPayload, {
    mappedTenantId: PIPELINE,
    environment: 'sandbox',
  });
  const getRecon = await reconcileExistingFromProviderGet(client, {
    providerTransferId: TRANSFER,
    providerStatus: 'completed',
    completedOn: COMPLETED_ON,
    environment: 'sandbox',
  });
  assert.equal(webhook.liveProviderCalled, false);
  assert.equal(getRecon.liveProviderPosted, false);
  assert.equal(webhook.createdPaymentTransfer, false);
  assert.equal(getRecon.createdPaymentTransfer, false);
  const files = [
    '../functions/api/providers/webhook-apply-production.mjs',
    '../functions/api/providers/moov-lifecycle.mjs',
    '../functions/api/providers/webhook-apply.mjs',
    '../providers/sql/78_moov_recon_parity.sql',
    '../providers/oneshot/m79i-run.mjs',
  ];
  for (const rel of files) {
    const src = sourceOf(rel);
    assert.doesNotMatch(src, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
    assert.doesNotMatch(src, /INSERT INTO public\.payment_transfers/i);
  }
});

test('sandbox apply uses provider completedOn and clears stale failure_reason', async () => {
  const client = mockClient({
    lookup: {
      ...staleCompleted,
      destination_recipient_id: null,
      amount_cents: 1,
      wallet_id: null,
      transfer_group_id: null,
      claim_id: null,
      check_id: null,
      description: 'fund',
    },
  });
  const result = await applyMoovWebhook(client, completedPayload, { mappedTenantId: PIPELINE });
  assert.equal(result.applied, true);
  const update = client.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.ok(update);
  assert.equal(update.params[3], COMPLETED_ON);
  assert.match(update.sql, /WHEN \$2 = 'completed' THEN NULL/);
  assert.doesNotMatch(update.sql, /failure_reason = COALESCE\(\$5, failure_reason\)/);
});

test('extractTransferEvent reads achDetails.completedOn and wallet events expose amounts', () => {
  const noTopLevel = extractTransferEvent({
    type: 'transfer.updated',
    data: {
      transferID: TRANSFER,
      status: 'completed',
      source: { achDetails: { completedOn: COMPLETED_ON } },
    },
  });
  assert.equal(noTopLevel.completedOn, COMPLETED_ON);
  const wallet = extractWalletEvent({
    type: 'walletTransaction.updated',
    data: {
      walletID: WALLET,
      availableBalance: { valueDecimal: '0.01' },
      pendingBalance: { value: 0 },
    },
  });
  assert.equal(wallet.isWalletEvent, true);
  assert.equal(wallet.availableCents, 1);
  assert.equal(wallet.pendingCents, 0);
  assert.equal(needsParityFill({
    status: 'completed',
    completed_at: COMPLETED_ON,
    failure_reason: null,
  }, noTopLevel), false);
});

test('GET recon fills completed_at and does not create a transfer', async () => {
  const client = mockClient();
  const result = await reconcileExistingFromProviderGet(client, {
    providerTransferId: TRANSFER,
    providerStatus: 'completed',
    completedOn: COMPLETED_ON,
    environment: 'sandbox',
  });
  assert.equal(result.applied, true);
  assert.equal(result.completed_at, COMPLETED_ON);
  assert.equal(result.failure_reason, null);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderPosted, false);
  assert.ok(client.queries.some((q) => q.sql.includes("set_config('request.moov_get_reconcile'")));
});

test('M7.9I runner overlays recon files, applies SQL 78, and never posts or arms flags', () => {
  const src = sourceOf('../providers/oneshot/m79i-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  const overlay = sourceOf('../providers/oneshot/m79-run.mjs');
  assert.match(src, /b18a96d7-4415-4df8-992f-70d5a17365a9/);
  assert.match(src, /dec24b01-e559-4014-b072-af1ac0e4d013/);
  assert.match(src, /apply_sql78/);
  assert.match(src, /reconcile_funding_parity/);
  assert.match(src, /78_moov_recon_parity\.sql/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
  assert.match(oneshot, /aws_moov_reconcile_wallet_cache/);
  assert.match(oneshot, /reconcileFundingParity/);
  assert.match(overlay, /providers\/moov-lifecycle\.mjs/);
  assert.match(overlay, /providers\/webhook-apply\.mjs/);
  const sql = sourceOf('../providers/sql/78_moov_recon_parity.sql');
  assert.doesNotMatch(sql, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
});
