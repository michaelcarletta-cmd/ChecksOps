/**
 * Collection V2 settlement synchronization.
 * Fixtures only. No Moov, AWS, SQL apply, or historical mutation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CHECKSOPS_PLATFORM_ACCOUNT_ID,
  CHECKSOPS_PLATFORM_WALLET_PM_ID,
  COLLECTION_STATUS,
  collectTenantObligation,
  createMemoryCollectionStore,
} from '../functions/api/tenant-collection-v2.mjs';
import { submitOccurrence } from '../functions/api/tenant-billing-engine.mjs';
import {
  COLLECTION_V2_COMPLETION_EVENT,
  applyBillingProviderEvent,
  applyCollectionV2ProviderCompletion,
  extractProviderTransferId,
  mapProviderStatusToBilling,
  obligationStatusAfterSubmit,
  planHistoricalCollectionV2Reconcile,
  providerCompletionTimestamp,
} from '../functions/api/tenant-collection-v2-settlement.mjs';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PAYMENT = '72b622f9-b68f-4032-a971-a854dbcfbf57';
const XFER = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
const OTHER_XFER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SETTLED_AT = '2026-10-02T19:16:01.649Z';

const obligation = (overrides = {}) => ({
  id: PAYMENT,
  tenant_id: FREEDOM,
  amount_cents: 13900,
  status: 'due',
  settled_at: null,
  occurrence_kind: 'monthly_subscription',
  billing_period: '2026-09',
  provider_environment: 'production',
  provider_transfer_id: XFER,
  notes: `Moov ACH pull (monthly_subscription) for 2026-09 · moov:${XFER}`,
  ...overrides,
});

const v2Leg = (overrides = {}) => ({
  id: 'leg-bank-1',
  tenant_id: FREEDOM,
  provider_transfer_id: XFER,
  status: 'submitted',
  environment: 'production',
  amount_cents: 13900,
  provider_metadata: {
    collection_contract: 'tenant-collection-v2',
    checksops_kind: 'monthly_subscription',
    obligation_id: PAYMENT,
    billing_period: '2026-09',
    leg_type: 'ach_debit',
  },
  ...overrides,
});

function createSettlementClient({
  row = obligation(),
  leg = null,
  events = [],
  account = { environment: 'production' },
} = {}) {
  const state = {
    obligation: row ? { ...row } : null,
    leg: leg ? { ...leg } : null,
    events: [...events],
  };
  const queries = [];
  return {
    state,
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM public.payment_transfers') && sql.includes('WHERE provider_transfer_id')) {
        return { rows: state.leg && state.leg.provider_transfer_id === params[0] ? [state.leg] : [] };
      }
      if (sql.includes('UPDATE public.payment_transfers')) {
        if (state.leg && state.leg.id === params[0]) {
          state.leg = {
            ...state.leg,
            status: params[1],
            provider_status: params[2],
            completed_at: params[1] === 'settled'
              ? (state.leg.completed_at || params[4] || SETTLED_AT)
              : state.leg.completed_at,
          };
        }
        return { rows: state.leg ? [state.leg] : [] };
      }
      if (sql.includes("provider_metadata->>'obligation_id'")) {
        return { rows: state.leg && String(state.leg.provider_metadata?.obligation_id) === String(params[0]) ? [state.leg] : [] };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments') && sql.includes('provider_transfer_id = $1')) {
        return { rows: state.obligation?.provider_transfer_id === params[0] ? [state.obligation] : [] };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments WHERE id = $1')) {
        return { rows: state.obligation?.id === params[0] ? [state.obligation] : [] };
      }
      if (sql.includes('notes LIKE')) {
        const token = String(params[0] || '').replaceAll('%', '');
        return { rows: String(state.obligation?.notes || '').includes(token) ? [state.obligation] : [] };
      }
      if (sql.includes('UPDATE public.tenant_maintenance_payments')) {
        if (!state.obligation || state.obligation.id !== params[0]) return { rows: [] };
        const nextStatus = params[1];
        state.obligation = {
          ...state.obligation,
          status: nextStatus,
          settled_at: nextStatus === 'settled'
            ? (state.obligation.settled_at || params[3] || SETTLED_AT)
            : state.obligation.settled_at,
          returned_at: nextStatus === 'returned'
            ? (state.obligation.returned_at || new Date().toISOString())
            : state.obligation.returned_at,
          return_reason: nextStatus === 'returned'
            ? (params[2] || state.obligation.return_reason || null)
            : state.obligation.return_reason,
        };
        return { rows: [state.obligation] };
      }
      if (sql.includes('FROM public.payment_event_log')) {
        return {
          rows: state.events.filter((event) => (
            event.provider_transfer_id === params[0]
            && event.event_type === params[1]
            && event.new_status === params[2]
          )),
        };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        const event = {
          id: `evt-${state.events.length + 1}`,
          provider_transfer_id: params[3],
          event_type: params[4],
          new_status: params[6],
          tenant_id: params[1],
          provider_metadata: params[7],
        };
        state.events.push(event);
        return { rows: [event] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: account ? [account] : [] };
      }
      return { rows: [] };
    },
  };
}

test('accepted in-flight ACH persists submitted, not due or settled', async () => {
  const store = createMemoryCollectionStore();
  const result = await collectTenantObligation(null, {
    occurrence: {
      id: PAYMENT,
      tenant_id: FREEDOM,
      billing_period: '2026-09',
      amount_cents: 13900,
      occurrence_kind: 'monthly_subscription',
      status: 'due',
    },
    readiness: {
      environment: 'production',
      authorization: {
        tenant_id: FREEDOM,
        provider_account_id: '60922058-7eca-4889-81dd-5720d7b9de96',
        provider_payment_method_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      account: { provider_account_id: '60922058-7eca-4889-81dd-5720d7b9de96' },
    },
    destination: {
      ok: true,
      accountId: CHECKSOPS_PLATFORM_ACCOUNT_ID,
      paymentMethodId: CHECKSOPS_PLATFORM_WALLET_PM_ID,
    },
    fetchImpl: async () => { throw new Error('live_fetch_refused'); },
    postTransfer: async ({ amount, idempotencyKey }) => ({
      transferID: XFER,
      status: 'pending',
      amount,
      idempotencyKey,
    }),
    resolveBillingDebitSource: async () => ({
      ok: true,
      sourceMethodId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceAccountId: '60922058-7eca-4889-81dd-5720d7b9de96',
      sourceRail: 'ach-debit-fund',
    }),
    deps: {
      store,
      simulate: true,
      wallet: {
        tenant_id: FREEDOM,
        environment: 'production',
        provider_account_id: '60922058-7eca-4889-81dd-5720d7b9de96',
        provider_wallet_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        provider_payment_method_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        available_cents: 0,
        pending_cents: 0,
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.obligation_status, 'submitted');
  assert.notEqual(result.obligation_status, 'due');
  assert.notEqual(result.obligation_status, 'settled');
  assert.equal(result.collection_status, COLLECTION_STATUS.BANK_PENDING);
  assert.equal(result.amount_received_cents, 0);
  assert.equal(store.snapshot().obligations[0].status, 'submitted');

  const updates = [];
  const client = {
    query: async (sql, params = []) => {
      if (sql.includes('UPDATE public.tenant_maintenance_payments')) {
        updates.push({ status: params[1], provider_transfer_id: params[2] });
        return { rows: [{ id: PAYMENT, status: params[1], provider_transfer_id: params[2] }] };
      }
      return { rows: [] };
    },
  };
  const submitted = await submitOccurrence(client, {
    occurrence: {
      id: PAYMENT,
      tenant_id: FREEDOM,
      amount_cents: 13900,
      status: 'due',
      occurrence_kind: 'monthly_subscription',
      billing_period: '2026-09',
    },
    readiness: { environment: 'sandbox', settings: null },
    destination: {
      ok: true,
      accountId: CHECKSOPS_PLATFORM_ACCOUNT_ID,
      paymentMethodId: CHECKSOPS_PLATFORM_WALLET_PM_ID,
    },
    deps: {
      simulate: true,
      store,
      postTransfer: async () => ({ transferID: XFER, status: 'pending' }),
      resolveBillingDebitSource: async () => ({
        ok: true,
        sourceMethodId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sourceAccountId: '60922058-7eca-4889-81dd-5720d7b9de96',
      }),
      wallet: {
        tenant_id: FREEDOM,
        environment: 'sandbox',
        provider_account_id: '60922058-7eca-4889-81dd-5720d7b9de96',
        provider_wallet_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        provider_payment_method_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        available_cents: 0,
      },
    },
  });
  assert.equal(submitted.occurrence.status, 'submitted');
  assert.equal(updates[0].status, 'submitted');
  assert.notEqual(updates[0].status, 'due');
  assert.notEqual(updates[0].status, 'settled');
});

test('submit helper never copies the preexisting due status', () => {
  assert.equal(obligationStatusAfterSubmit({
    collected: {
      ok: true,
      collection_status: COLLECTION_STATUS.BANK_PENDING,
      amount_received_cents: 0,
      amount_due_cents: 13900,
      legs: [{ provider_transfer_id: XFER, status: 'pending' }],
    },
    occurrence: { status: 'due', amount_cents: 13900 },
  }), 'submitted');
  assert.equal(obligationStatusAfterSubmit({
    collected: { ok: false, error: 'bank_rejected' },
    occurrence: { status: 'due' },
  }), 'failed');
});

test('provider pending does not settle the obligation', async () => {
  const client = createSettlementClient({ row: obligation({ status: 'submitted' }) });
  const pending = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'pending',
    environment: 'production',
  });
  assert.equal(pending.applied, false);
  assert.equal(pending.skipped, 'unmapped_status');
  assert.equal(client.state.obligation.status, 'submitted');
  assert.equal(client.state.obligation.settled_at, null);
});

test('provider completed settles TMP with the provider timestamp', async () => {
  const client = createSettlementClient({ row: obligation({ status: 'submitted' }) });
  const applied = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    completedAt: SETTLED_AT,
    environment: 'production',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.occurrence.status, 'settled');
  assert.equal(applied.occurrence.settled_at, SETTLED_AT);
  assert.equal(applied.duplicate, false);
});

test('completion event carries durable provider and payment identities', async () => {
  const client = createSettlementClient({ row: obligation({ status: 'submitted' }) });
  const applied = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    completedAt: SETTLED_AT,
    environment: 'production',
  });
  assert.equal(applied.event.written, true);
  const insert = client.queries.find((query) => query.sql.includes('INSERT INTO public.payment_event_log'));
  assert.equal(insert.params[3], XFER);
  assert.equal(insert.params[4], COLLECTION_V2_COMPLETION_EVENT);
  assert.equal(insert.params[6], 'settled');
  const metadata = JSON.parse(insert.params[7]);
  assert.equal(metadata.checksops_payment_id, PAYMENT);
  assert.equal(metadata.collection_contract, 'tenant-collection-v2');
  assert.equal(metadata.checksops_kind, 'monthly_subscription');
  assert.ok(!insert.sql.includes('ILIKE'));
});

test('duplicate completion is idempotent and keeps the original settled_at', async () => {
  const client = createSettlementClient({
    row: obligation({ status: 'settled', settled_at: SETTLED_AT }),
    events: [{
      id: 'evt-existing',
      provider_transfer_id: XFER,
      event_type: COLLECTION_V2_COMPLETION_EVENT,
      new_status: 'settled',
    }],
  });
  const replay = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    completedAt: '2026-10-03T00:00:00.000Z',
    environment: 'production',
  });
  assert.equal(replay.applied, true);
  assert.equal(replay.duplicate, true);
  assert.equal(client.state.obligation.status, 'settled');
  assert.equal(client.state.obligation.settled_at, SETTLED_AT);
  assert.equal(replay.event.duplicate, true);
  assert.equal(client.queries.some((query) => query.sql.includes('UPDATE public.tenant_maintenance_payments')), false);
});

test('returned or failed provider status cannot become settled', async () => {
  const failedClient = createSettlementClient({ row: obligation({ status: 'submitted' }) });
  const failed = await applyBillingProviderEvent(failedClient, {
    providerTransferId: XFER,
    status: 'failed',
    environment: 'production',
  });
  assert.equal(failed.applied, true);
  assert.equal(failed.occurrence.status, 'failed');
  assert.equal(failed.occurrence.settled_at, null);

  const returnedClient = createSettlementClient({ row: obligation({ status: 'submitted' }) });
  const returned = await applyBillingProviderEvent(returnedClient, {
    providerTransferId: XFER,
    status: 'returned',
    environment: 'production',
  });
  assert.equal(returned.occurrence.status, 'returned');
  assert.notEqual(returned.occurrence.status, 'settled');

  const already = createSettlementClient({ row: obligation({ status: 'settled', settled_at: SETTLED_AT }) });
  const refuseFail = await applyBillingProviderEvent(already, {
    providerTransferId: XFER,
    status: 'failed',
    environment: 'production',
  });
  assert.equal(refuseFail.applied, false);
  assert.equal(refuseFail.skipped, 'already_settled');
  assert.equal(already.state.obligation.status, 'settled');
});

test('settled then returned is applied and is not hidden by prior settlement', async () => {
  const client = createSettlementClient({
    row: obligation({ status: 'settled', settled_at: SETTLED_AT }),
  });
  const reversed = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'returned',
    reason: 'ach_return',
    environment: 'production',
  });
  assert.equal(reversed.applied, true);
  assert.equal(reversed.skipped, undefined);
  assert.equal(reversed.occurrence.status, 'returned');
  assert.equal(client.state.obligation.status, 'returned');
  assert.equal(client.state.obligation.settled_at, SETTLED_AT);
  assert.ok(client.state.obligation.returned_at);
  assert.equal(client.state.obligation.return_reason, 'ach_return');
  assert.equal(client.queries.some((query) => query.sql.includes('UPDATE public.tenant_maintenance_payments')), true);
  assert.equal(reversed.event.written, true);
});

test('unrelated Moov transfers cannot settle another obligation', async () => {
  const client = createSettlementClient({
    row: obligation(),
    leg: {
      id: 'payout-1',
      tenant_id: OTHER,
      provider_transfer_id: OTHER_XFER,
      status: 'completed',
      provider_metadata: { kind: 'disbursement' },
    },
  });
  const unrelated = await applyBillingProviderEvent(client, {
    providerTransferId: OTHER_XFER,
    status: 'completed',
    environment: 'production',
  });
  assert.equal(unrelated.applied, false);
  assert.ok(['unrelated_transfer', 'no_billing_occurrence'].includes(unrelated.skipped));
  assert.equal(client.state.obligation.status, 'due');
});

test('tenant isolation stays intact', async () => {
  const client = createSettlementClient({
    row: obligation({ tenant_id: FREEDOM }),
  });
  const applied = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    completedAt: SETTLED_AT,
    environment: 'production',
  });
  assert.equal(applied.occurrence.tenant_id, FREEDOM);
  const insert = client.queries.find((query) => query.sql.includes('INSERT INTO public.payment_event_log'));
  assert.equal(insert.params[1], FREEDOM);
});

test('production and sandbox identities cannot cross', async () => {
  const client = createSettlementClient({
    row: obligation({ provider_environment: 'production' }),
  });
  const crossed = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    environment: 'sandbox',
  });
  assert.equal(crossed.applied, false);
  assert.equal(crossed.skipped, 'environment_mismatch');
  assert.equal(client.state.obligation.status, 'due');
  assert.equal(client.state.obligation.settled_at, null);
});

test('existing payment-transfer legs synchronize without manufacturing a new one', async () => {
  const client = createSettlementClient({
    row: obligation({ status: 'submitted' }),
    leg: v2Leg(),
  });
  const applied = await applyBillingProviderEvent(client, {
    providerTransferId: XFER,
    status: 'completed',
    completedAt: SETTLED_AT,
    environment: 'production',
  });
  assert.equal(applied.applied, true);
  assert.equal(client.state.leg.status, 'settled');
  assert.equal(client.state.leg.completed_at, SETTLED_AT);
  assert.equal(client.queries.filter((query) => query.sql.includes('INSERT INTO public.payment_transfers')).length, 0);
});

test('webhook router uses durable transfer id and skips dry-run / pending', async () => {
  assert.equal(extractProviderTransferId({ data: { transferID: XFER, status: 'completed' } }), XFER);
  assert.equal(mapProviderStatusToBilling('pending'), null);
  assert.equal(providerCompletionTimestamp({ data: { completedOn: SETTLED_AT } }), SETTLED_AT);

  const dry = await applyCollectionV2ProviderCompletion(
    createSettlementClient({ row: obligation({ status: 'submitted' }) }),
    { type: 'transfer.updated', data: { transferID: XFER, status: 'completed', completedOn: SETTLED_AT } },
    { dryRun: true },
  );
  assert.equal(dry.applied, false);
  assert.equal(dry.skipped, 'dry_run');

  const client = createSettlementClient({
    row: obligation({ status: 'submitted' }),
    account: { environment: 'production' },
  });
  const applied = await applyCollectionV2ProviderCompletion(client, {
    type: 'transfer.completed',
    accountID: '41cb5d67-4911-4bef-aad5-d8ee9c582208',
    data: { transferID: XFER, status: 'completed', completedOn: SETTLED_AT },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.occurrence.status, 'settled');
  assert.equal(applied.occurrence.settled_at, SETTLED_AT);
});

test('historical reconcile stays design-only and forbids due+transfer-id inference', () => {
  const plan = planHistoricalCollectionV2Reconcile(obligation({ status: 'due' }));
  assert.equal(plan.action, 'read_provider_then_apply');
  assert.match(plan.forbidden, /without provider confirmation/);
  assert.equal(planHistoricalCollectionV2Reconcile({ status: 'due' }).action, 'none');
});

test('settlement module never moves money', () => {
  const source = readFileSync(new URL('../functions/api/tenant-collection-v2-settlement.mjs', import.meta.url), 'utf8');
  assert.equal(/moovFetch|postTransferLedger|transfersWrite|ACH debit|sourceMethodId/.test(source), false);
  const webhooks = readFileSync(new URL('./fixtures/live-webhooks.mjs', import.meta.url), 'utf8');
  assert.match(webhooks, /applyCollectionV2ProviderCompletion/);
  assert.match(webhooks, /!dryRun/);
  assert.equal(
    createHash('sha256').update(webhooks).digest('hex'),
    '4bd776a7766b0bd63e17ba18e790e28bb0b4fb8a7c9cceb271bf4f84280e7681',
  );
});
