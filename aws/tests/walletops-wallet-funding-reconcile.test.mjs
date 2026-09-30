/**
 * Idempotent recovery of an existing Moov wallet-funding transfer.
 * Fixtures only. No provider writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WALLET_FUNDING_LEG_ROLE,
  buildWalletFundingRecoveryRow,
  createMemoryWalletFundingStore,
  normalizeWalletFundingStatus,
  reconcileWalletFundingTransfer,
} from '../../src/lib/payments/reconcileWalletFundingTransfer.ts';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FIVE = '9f9df312-32a9-4999-ace9-fc2b00669c75';
const BANK_PM = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const WALLET_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';
const LOCAL_BANK = '8eb5b26e-6f66-435c-a578-880fb7fc14dd';

const freedomFive = (over = {}) => ({
  tenantId: FREEDOM,
  environment: 'production',
  amountCents: 500,
  providerTransferId: FIVE,
  providerStatus: 'pending',
  description: 'Balance funding',
  sourceAccountId: '60922058-7eca-4889-81dd-5720d7b9de96',
  localSourcePaymentMethodId: LOCAL_BANK,
  sourcePaymentMethodId: BANK_PM,
  destinationPaymentMethodId: WALLET_PM,
  ...over,
});

test('10 provider_transfer_id recovery inserts exactly one local row', () => {
  const store = createMemoryWalletFundingStore();
  const first = reconcileWalletFundingTransfer(store, freedomFive());
  assert.equal(first.action, 'insert');
  assert.equal(store.rows.length, 1);
  assert.equal(first.row.provider_transfer_id, FIVE);
  assert.equal(first.row.leg_role, WALLET_FUNDING_LEG_ROLE);
  assert.equal(first.row.amount_cents, 500);
  assert.equal(first.row.environment, 'production');
  assert.equal(first.row.tenant_id, FREEDOM);
  assert.equal(first.row.provider_metadata.destination_payment_method_id, WALLET_PM);
  assert.equal(first.row.provider_metadata.source_payment_method_id, BANK_PM);
});

test('11 second recovery updates the same row and creates no duplicate', () => {
  const store = createMemoryWalletFundingStore();
  reconcileWalletFundingTransfer(store, freedomFive());
  const second = reconcileWalletFundingTransfer(store, freedomFive({ providerStatus: 'completed' }));
  assert.equal(second.action, 'update');
  assert.equal(store.rows.length, 1);
  assert.equal(second.row.status, 'completed');
  assert.equal(second.row.provider_status, 'completed');
  assert.equal(second.row.provider_transfer_id, FIVE);
});

test('12 cross-tenant isolation refuses another organization\'s provider id', () => {
  const store = createMemoryWalletFundingStore();
  reconcileWalletFundingTransfer(store, freedomFive());
  assert.throws(
    () => reconcileWalletFundingTransfer(store, freedomFive({ tenantId: OTHER })),
    /another organization/,
  );
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].tenant_id, FREEDOM);
});

test('status mapper follows the canonical Moov mapper', () => {
  assert.equal(normalizeWalletFundingStatus('pending'), 'pending');
  assert.equal(normalizeWalletFundingStatus('completed'), 'completed');
  assert.equal(normalizeWalletFundingStatus('failed'), 'failed');
  assert.equal(normalizeWalletFundingStatus('canceled'), 'canceled');
  assert.equal(normalizeWalletFundingStatus('created'), 'submitted');
});

test('recovery row does not invent a new provider transfer id', () => {
  const row = buildWalletFundingRecoveryRow(freedomFive());
  assert.equal(row.provider_transfer_id, FIVE);
  assert.notEqual(row.provider_transfer_id, 'new');
});
