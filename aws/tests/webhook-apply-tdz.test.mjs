/**
 * Surgical TDZ repair for live providers/webhook-apply.mjs.
 * Fixtures only. No Moov, AWS, SQL apply, webhook replay, or money movement.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';

const REPAIRED_SHA = 'adc59fbba6d16ab36bef3667d1ef8f636c43e754f0a8fe523ce93859341d56f9';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TRANSFER_ID = 'tr_sandbox_tdz_1';
const TRANSFER_ROW = {
  id: '55555555-5555-4555-8555-555555555555',
  tenant_id: FREEDOM,
  status: 'submitted',
  destination_recipient_id: null,
  amount_cents: 1,
  wallet_id: null,
  leg_role: null,
  transfer_group_id: null,
  claim_id: null,
  check_id: null,
  description: 'sandbox penny',
};

const webhookApplySource = () => readFileSync(new URL('../functions/api/providers/webhook-apply.mjs', import.meta.url), 'utf8');

const createApplyClient = ({
  sandboxAccount = { id: 'acct-1', tenant_id: FREEDOM, environment: 'sandbox', onboarding_status: 'active' },
  productionAccount = null,
  transfer = TRANSFER_ROW,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM public.payment_provider_accounts") && sql.includes("environment = 'sandbox'")) {
        return { rows: sandboxAccount ? [sandboxAccount] : [] };
      }
      if (sql.includes("FROM public.payment_provider_accounts") && sql.includes("environment = 'production'")) {
        return { rows: productionAccount ? [productionAccount] : [] };
      }
      if (sql.includes('FROM public.payment_transfers') && sql.includes("environment = 'sandbox'")) {
        return { rows: transfer && params[0] === TRANSFER_ID ? [transfer] : [] };
      }
      if (sql.includes('FROM public.payment_transfers') && sql.includes('WHERE provider_transfer_id')) {
        return { rows: [] };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments')) return { rows: [] };
      if (sql.includes('UPDATE public.payment_transfers')) return { rows: transfer ? [transfer] : [] };
      return { rows: [] };
    },
  };
};

test('the live TDZ shape is a ReferenceError when transferId is read before init', () => {
  const broken = new Function(`
    if (transferId) return transferId;
    const transferId = 'x';
    return transferId;
  `);
  assert.throws(broken, { name: 'ReferenceError' });
});

test('repaired member declares transferId before the billing-provider-event call', () => {
  const source = webhookApplySource();
  const billingIdx = source.indexOf('if (transferId) {\n    const billing = await applyBillingProviderEvent');
  const declIdx = source.indexOf('const transferId = data?.transferID ?? data?.transferId ?? null;');
  assert.ok(declIdx >= 0);
  assert.ok(billingIdx > declIdx);
  assert.equal(source.includes('applyCollectionV2ProviderCompletion'), false);
  assert.equal((source.match(/const transferId = /g) || []).length, 1);
});

test('transfer.completed no longer throws and forwards the transfer id to billing', async () => {
  const client = createApplyClient();
  const applied = await applyMoovWebhook(client, {
    type: 'transfer.completed',
    accountID: 'sandbox-acct',
    data: { transferID: TRANSFER_ID, status: 'completed' },
  }, { mappedTenantId: FREEDOM });
  assert.equal(applied.applied, true);
  assert.equal(applied.environment, 'sandbox');
  const billingLookup = client.queries.find((query) => (
    query.sql.includes('FROM public.payment_transfers')
    && query.sql.includes('WHERE provider_transfer_id = $1')
    && !query.sql.includes("environment = 'sandbox'")
  ));
  assert.ok(billingLookup);
  assert.equal(billingLookup.params[0], TRANSFER_ID);
  assert.ok(applied.mutations.includes('payment_transfers'));
});

test('absent transfer id skips the billing-provider-event call', async () => {
  const client = createApplyClient();
  const applied = await applyMoovWebhook(client, {
    type: 'transfer.updated',
    accountID: 'sandbox-acct',
    data: { status: 'completed' },
  }, { mappedTenantId: FREEDOM });
  assert.equal(applied.applied, true);
  assert.equal(applied.mutations.includes('tenant_maintenance_payments'), false);
  assert.equal(client.queries.some((query) => (
    query.sql.includes('FROM public.payment_transfers')
    && query.sql.includes('WHERE provider_transfer_id = $1')
  )), false);
});

test('sandbox transfer apply and production-environment refusal stay unchanged', async () => {
  const sandbox = createApplyClient();
  const applied = await applyMoovWebhook(sandbox, {
    type: 'transfer.updated',
    accountID: 'sandbox-acct',
    data: { transferID: TRANSFER_ID, status: 'completed' },
  }, { mappedTenantId: FREEDOM });
  assert.equal(applied.applied, true);
  assert.equal(applied.environment, 'sandbox');
  assert.ok(applied.mutations.includes('payment_transfers'));
  assert.ok(sandbox.queries.some((query) => query.sql.includes("environment = 'sandbox'")));

  const production = createApplyClient({
    sandboxAccount: null,
    productionAccount: { id: 'prod-1', environment: 'production' },
  });
  const refused = await applyMoovWebhook(production, {
    type: 'transfer.completed',
    accountID: 'prod-acct',
    data: { transferID: TRANSFER_ID, status: 'completed' },
  });
  assert.equal(refused.applied, false);
  assert.equal(refused.skipped, 'production_environment_row');
  assert.equal(refused.financialTablesMutated, false);
  assert.equal(production.queries.some((query) => query.sql.includes('applyBillingProviderEvent')), false);
  assert.equal(production.queries.some((query) => (
    query.sql.includes('FROM public.payment_transfers')
    && query.sql.includes('WHERE provider_transfer_id = $1')
  )), false);
});

test('receipt table and new money movement are not introduced in webhook-apply', () => {
  const source = webhookApplySource();
  const sha = createHash('sha256').update(source).digest('hex');
  assert.equal(sha, REPAIRED_SHA);
  assert.equal(source.includes('aws_provider_webhook_receipts'), false);
  assert.equal(source.includes('applyCollectionV2ProviderCompletion'), false);
  for (const token of ['moovFetch', 'transfersWrite', 'ACH debit', 'sourceMethodId']) {
    assert.equal(source.includes(token), false);
  }
  assert.equal(source.includes('postTransferLedger'), true);
  assert.equal(source.includes("import { applyBillingProviderEvent } from '../tenant-billing-engine.mjs';"), true);
});
