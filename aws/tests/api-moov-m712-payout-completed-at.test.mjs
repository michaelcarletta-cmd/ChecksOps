import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';
import {
  applyProductionMoovWebhook,
  reconcileExistingFromProviderGet,
} from '../functions/api/providers/webhook-apply-production.mjs';
import {
  canTransition,
  completedAtFor,
  extractTransferEvent,
} from '../functions/api/providers/moov-lifecycle.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_FUNDING_INTENT_ID,
  M712_FUNDING_TRANSFER_ID,
  M712_OPERATION_ID,
  M712_PAYOUT_INTENT_ID,
  M712_PAYOUT_TRANSFER_ID,
} from '../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COMPLETED_ON = '2026-09-21T19:46:00.803144Z';
const RECEIPT_TIME = '2026-09-21T19:46:02.939Z';
const DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';

const destinationCompletedPayload = {
  type: 'transfer.updated',
  eventID: 'm712-completion',
  accountID: PIPELINE_TEST_SANDBOX.accountId,
  createdOn: RECEIPT_TIME,
  data: {
    transferID: M712_PAYOUT_TRANSFER_ID,
    status: 'completed',
    amount: { currency: 'USD', valueDecimal: '0.01' },
    source: {
      paymentMethodID: PIPELINE_TEST_SANDBOX.walletPm,
      paymentMethodType: 'moov-wallet',
    },
    destination: {
      paymentMethodID: DEST_PM,
      paymentMethodType: 'ach-credit-standard',
      achDetails: { completedOn: COMPLETED_ON, status: 'completed' },
    },
  },
};

const processingRow = {
  id: M712_PAYOUT_INTENT_ID,
  tenant_id: PIPELINE,
  status: 'processing',
  environment: 'sandbox',
  amount_cents: 1,
  completed_at: null,
  provider_status: 'processing',
  provider_transfer_id: M712_PAYOUT_TRANSFER_ID,
  leg_role: 'wallet_disbursement',
  failure_reason: null,
  destination_recipient_id: null,
  wallet_id: null,
  transfer_group_id: null,
  claim_id: null,
  check_id: null,
  description: 'payout',
};

const mockClient = ({
  lookup = processingRow,
  productionAccount = false,
  sandboxAccount = true,
} = {}) => {
  const queries = [];
  const inserts = [];
  return {
    queries,
    inserts,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        inserts.push('payment_transfers');
        throw new Error('payment_transfers_insert_forbidden');
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('FROM public.payment_provider_accounts')) {
        if (sql.includes("environment = 'sandbox'") && sandboxAccount) {
          return {
            rows: [{
              id: 'sandbox-acct',
              tenant_id: PIPELINE,
              environment: 'sandbox',
              onboarding_status: 'active',
            }],
          };
        }
        if (sql.includes("environment = 'production'") && productionAccount) {
          return { rows: [{ id: 'prod-acct', environment: 'production' }] };
        }
        return { rows: [] };
      }
      if (sql.includes('aws_moov_lookup_transfer')) {
        const env = params[1];
        if (!lookup || lookup.environment !== env) return { rows: [] };
        if (String(params[0]) !== String(lookup.provider_transfer_id)) return { rows: [] };
        return { rows: [{ ...lookup }] };
      }
      if (sql.includes('FROM public.payment_transfers') && !sql.includes('UPDATE')) {
        if (sql.includes("environment = 'sandbox'")) {
          return {
            rows: lookup && lookup.environment === 'sandbox' ? [{ ...lookup }] : [],
          };
        }
        if (sql.includes("environment = 'production'")) {
          return {
            rows: lookup && lookup.environment === 'production' ? [{ ...lookup }] : [],
          };
        }
        return { rows: lookup ? [{ ...lookup }] : [] };
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
      if (sql.includes('aws_moov_observe_provider_activity')) {
        return { rows: [{ observed_id: 'obs-1', observed_transfer_id: params[1] }] };
      }
      if (sql.includes('aws_moov_record_reconcile_event')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE public.payment_transfers')) {
        if (sql.includes("environment = 'production'")) {
          throw new Error('production_row_mutated');
        }
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

test('1 processing → completed webhook with destination completedOn stamps exact completed_at', async () => {
  const client = mockClient();
  const result = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  assert.equal(result.applied, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.completed_at, COMPLETED_ON);
  assert.equal(result.failure_reason, null);
  assert.equal(result.createdPaymentTransfer, false);
  const update = client.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.ok(update);
  assert.equal(update.params[1], 'completed');
  assert.equal(update.params[2], 'completed');
  assert.equal(update.params[3], COMPLETED_ON);
  assert.match(update.sql, /completed_at = COALESCE\(\$4::timestamptz, completed_at\)/);
  assert.doesNotMatch(update.sql, /completed_at\s*=\s*now\(\)/i);
});

test('2 completed_at uses provider completedOn, not webhook receipt time', async () => {
  const client = mockClient();
  await applyMoovWebhook(client, destinationCompletedPayload, { mappedTenantId: PIPELINE });
  const update = client.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.equal(update.params[3], COMPLETED_ON);
  assert.notEqual(update.params[3], RECEIPT_TIME);
  assert.notEqual(update.params[3], 'now()');
  const extracted = extractTransferEvent(destinationCompletedPayload);
  assert.equal(extracted.completedOn, COMPLETED_ON);
  assert.equal(completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: extracted.completedOn,
    existingCompletedAt: null,
  }), COMPLETED_ON);
  const webhookSrc = sourceOf('../functions/api/providers/webhook-apply.mjs');
  assert.match(webhookSrc, /extractTransferEvent/);
  assert.match(webhookSrc, /completedAtFor/);
  assert.doesNotMatch(
    webhookSrc.slice(webhookSrc.indexOf('const completedAt = completedAtFor'), webhookSrc.indexOf('const failureReason')),
    /now\(\)/,
  );
});

test('3 repeated completed webhook is idempotent', async () => {
  const client = mockClient();
  const first = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  const second = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  assert.equal(first.applied, true);
  assert.equal(first.skipped, null);
  assert.equal(second.applied, true);
  assert.equal(second.skipped, 'idempotent_same_status');
  assert.equal(second.financialTablesMutated, false);
  assert.equal(second.completed_at, COMPLETED_ON);
  assert.equal(
    client.queries.filter((q) => q.sql.includes('UPDATE public.payment_transfers')).length,
    1,
  );
});

test('4 terminal completed row cannot regress to processing/pending', async () => {
  const filled = {
    ...processingRow,
    status: 'completed',
    provider_status: 'completed',
    completed_at: COMPLETED_ON,
    failure_reason: null,
  };
  const client = mockClient({ lookup: filled });
  const processing = await applyMoovWebhook(client, {
    ...destinationCompletedPayload,
    data: { ...destinationCompletedPayload.data, status: 'processing' },
  }, { mappedTenantId: PIPELINE });
  const pending = await applyMoovWebhook(client, {
    ...destinationCompletedPayload,
    data: { ...destinationCompletedPayload.data, status: 'pending' },
  }, { mappedTenantId: PIPELINE });
  assert.equal(canTransition('completed', 'processing').ok, false);
  assert.equal(canTransition('completed', 'pending').ok, false);
  assert.equal(processing.applied, false);
  assert.equal(processing.skipped, 'terminal_regression');
  assert.equal(processing.status, 'completed');
  assert.equal(processing.completed_at, COMPLETED_ON);
  assert.equal(pending.skipped, 'terminal_regression');
  assert.ok(!client.queries.some((q) => q.sql.includes('UPDATE public.payment_transfers')));
});

test('5 unknown provider transfer does not create an intent', async () => {
  const client = mockClient({ lookup: null });
  const result = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  assert.equal(result.applied, true);
  assert.equal(result.note, 'unknown_sandbox_transfer');
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.financialTablesMutated, false);
  assert.equal(client.inserts.length, 0);
  assert.ok(!client.queries.some((q) => q.sql.includes('UPDATE public.payment_transfers')));
  assert.ok(client.queries.some((q) => q.sql.includes('INSERT INTO public.payment_event_log')));
});

test('6 sandbox event cannot mutate production intent', async () => {
  const client = mockClient({
    lookup: { ...processingRow, environment: 'production', tenant_id: FREEDOM },
    sandboxAccount: true,
    productionAccount: false,
  });
  const result = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  assert.equal(result.note, 'unknown_sandbox_transfer');
  assert.equal(result.createdPaymentTransfer, false);
  assert.ok(!client.queries.some((q) => q.sql.includes('UPDATE public.payment_transfers')));
  assert.equal(client.inserts.length, 0);
});

test('7 production event cannot mutate sandbox intent', async () => {
  const sandboxClient = mockClient({
    lookup: processingRow,
    sandboxAccount: false,
    productionAccount: true,
  });
  const sandboxApply = await applyMoovWebhook(sandboxClient, {
    ...destinationCompletedPayload,
    accountID: '60922058-7eca-4889-81dd-5720d7b9de96',
  }, { mappedTenantId: FREEDOM });
  assert.equal(sandboxApply.applied, false);
  assert.equal(sandboxApply.skipped, 'production_environment_row');
  assert.equal(sandboxApply.financialTablesMutated, false);
  assert.ok(!sandboxClient.queries.some((q) => q.sql.includes('UPDATE public.payment_transfers')));

  const prodClient = mockClient({ lookup: processingRow });
  const productionApply = await applyProductionMoovWebhook(prodClient, destinationCompletedPayload, {
    mappedTenantId: FREEDOM,
    environment: 'production',
  });
  assert.equal(productionApply.applied, true);
  assert.equal(productionApply.skipped, 'unknown_transfer_observed_only');
  assert.equal(productionApply.createdPaymentTransfer, false);
  assert.ok(!prodClient.queries.some((q) => q.sql.includes('aws_moov_reconcile_existing_transfer')));
  assert.ok(prodClient.queries.some((q) => q.sql.includes('aws_moov_observe_provider_activity')));
});

test('8 GET reconciliation and webhook reconciliation converge on the same completed_at', async () => {
  const webhookClient = mockClient();
  const webhook = await applyMoovWebhook(webhookClient, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  const getClient = mockClient();
  const getRecon = await reconcileExistingFromProviderGet(getClient, {
    providerTransferId: M712_PAYOUT_TRANSFER_ID,
    providerStatus: 'completed',
    completedOn: extractTransferEvent(destinationCompletedPayload).completedOn,
    environment: 'sandbox',
  });
  assert.equal(webhook.completed_at, COMPLETED_ON);
  assert.equal(getRecon.completed_at, COMPLETED_ON);
  assert.equal(webhook.completed_at, getRecon.completed_at);
  assert.equal(getRecon.createdPaymentTransfer, false);
  assert.equal(getRecon.liveProviderPosted, false);
  const getUpdate = getClient.queries.find((q) => q.sql.includes('aws_moov_reconcile_existing_transfer'));
  const webhookUpdate = webhookClient.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.equal(getUpdate.params[3], webhookUpdate.params[3]);
  assert.equal(getUpdate.params[3], COMPLETED_ON);
});

test('9 failure_reason remains null for successful completion', async () => {
  const client = mockClient();
  const result = await applyMoovWebhook(client, destinationCompletedPayload, {
    mappedTenantId: PIPELINE,
  });
  assert.equal(result.failure_reason, null);
  const update = client.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.match(update.sql, /WHEN \$2 = 'completed' THEN NULL/);
  assert.equal(update.params[4], null);
});

test('10 M7.12 still has exactly one funding and one payout intent/transfer', () => {
  assert.equal(M712_OPERATION_ID, '69704e23-9ddd-52f8-a2b1-d48bdb500926');
  assert.equal(M712_FUNDING_INTENT_ID, '985f487b-74f2-4d9f-8e6f-7cad9ae10c97');
  assert.equal(M712_PAYOUT_INTENT_ID, 'df6e3d55-ccc9-43cd-b275-8cde8e24c343');
  assert.equal(M712_FUNDING_TRANSFER_ID, 'e42635e8-7a75-4d25-ad2f-dd0e5696372d');
  assert.equal(M712_PAYOUT_TRANSFER_ID, 'c7026476-42d3-43af-bfd3-6f5c4d6480e7');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  const runner = sourceOf('../providers/oneshot/m712-completed-at-run.mjs');
  const applySrc = sourceOf('../functions/api/providers/webhook-apply.mjs');
  assert.match(oneshot, /reconcile_m712_payout_completed_at/);
  assert.match(oneshot, /m712_payout_intent_mismatch/);
  assert.match(oneshot, new RegExp(M712_PAYOUT_INTENT_ID));
  assert.match(oneshot, new RegExp(M712_PAYOUT_TRANSFER_ID));
  assert.match(oneshot, /fundingIntentCount !== 1/);
  assert.match(oneshot, /payoutIntentCount !== 1/);
  assert.match(oneshot, /mode: 'update_existing_only'/);
  assert.doesNotMatch(applySrc, /INSERT INTO public\.payment_transfers/i);
  assert.doesNotMatch(runner, /persist_orchestrator_intent/);
  assert.doesNotMatch(runner, /persist_payout_intent/);
  assert.doesNotMatch(runner, /persist_funding_intent/);
  assert.doesNotMatch(runner, /setSandboxPostFlag/);
  assert.doesNotMatch(runner, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(runner, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(runner, /checksops-staging-api/);
  assert.doesNotMatch(runner, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
});

test('absent completedOn does not invent a provider completion timestamp', async () => {
  const client = mockClient();
  const result = await applyMoovWebhook(client, {
    type: 'transfer.updated',
    accountID: PIPELINE_TEST_SANDBOX.accountId,
    data: {
      transferID: M712_PAYOUT_TRANSFER_ID,
      status: 'completed',
      source: { paymentMethodType: 'moov-wallet' },
      destination: { paymentMethodType: 'ach-credit-standard' },
    },
  }, { mappedTenantId: PIPELINE });
  assert.equal(result.applied, true);
  assert.equal(result.status, 'completed');
  const update = client.queries.find((q) => q.sql.includes('UPDATE public.payment_transfers'));
  assert.equal(update.params[3], null);
  assert.equal(completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: null,
    existingCompletedAt: null,
  }), null);
});
