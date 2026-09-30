/**
 * WalletOps wallet-relative Pending In / Pending Out + billing activity.
 * Fixtures only. No provider writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBillingActivity,
  classifyWalletRelativeTransfer,
  dedupeTransfers,
  summarizeWalletOps,
} from '../../src/lib/payments/walletRelativeTransfers.ts';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const WALLET_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';
const OTHER_WALLET_PM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BANK_PM = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const CHECKSOPS_PM = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const LOCAL_BANK_ROW = '16f34548-550c-4b51-8c92-8b77d810ed45';

const methods = [
  {
    id: LOCAL_BANK_ROW,
    provider_payment_method_id: '7a78a544-340d-46fd-a4a4-228661374da7',
    last_four: '4573',
    bank_name: 'WELLS FARGO BANK',
    rail_payment_method_ids: { 'ach-debit-fund': BANK_PM },
  },
];

const transfer = (over = {}) => ({
  id: over.id || '11111111-1111-4111-8111-111111111111',
  tenant_id: FREEDOM,
  amount_cents: 500,
  status: 'pending',
  source_payment_method_id: BANK_PM,
  destination_payment_method_id: WALLET_PM,
  ...over,
});

test('1 bank → tenant wallet is Pending In', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer(),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'pending_in');
  assert.equal(row.pendingInCents, 500);
  assert.equal(row.pendingOutCents, 0);
});

test('2 tenant wallet → bank is Pending Out', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer({
      amount_cents: 25000,
      source_payment_method_id: WALLET_PM,
      destination_payment_method_id: BANK_PM,
    }),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'pending_out');
  assert.equal(row.pendingOutCents, 25000);
});

test('3 tenant wallet → another wallet is Pending Out', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer({
      source_payment_method_id: WALLET_PM,
      destination_payment_method_id: OTHER_WALLET_PM,
      amount_cents: 1000,
    }),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'pending_out');
});

test('4 another wallet → tenant wallet is Pending In', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer({
      source_payment_method_id: OTHER_WALLET_PM,
      destination_payment_method_id: WALLET_PM,
      amount_cents: 1000,
    }),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'pending_in');
});

test('5 tenant bank → ChecksOps wallet is neither', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer({
      amount_cents: 13900,
      source_payment_method_id: BANK_PM,
      destination_payment_method_id: CHECKSOPS_PM,
      description: 'ChecksOps subscription 2026-09 bank',
      provider_metadata: {
        collection_contract: 'tenant-collection-v2',
        checksops_period: '2026-09',
        checksops_leg: 'ach_debit',
      },
    }),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'neither');
  assert.equal(row.pendingInCents, 0);
  assert.equal(row.pendingOutCents, 0);
});

test('6 $139 bill wallet $0 / bank $139 contributes $0 Pending Out', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [transfer({
      id: 'bill-bank',
      amount_cents: 13900,
      source_payment_method_id: BANK_PM,
      destination_payment_method_id: CHECKSOPS_PM,
      idempotency_key: `billing-2026-09-${FREEDOM}-bank`,
      provider_metadata: {
        collection_contract: 'tenant-collection-v2',
        checksops_period: '2026-09',
        checksops_leg: 'ach_debit',
        checksops_tenant_id: FREEDOM,
      },
    })],
  });
  assert.equal(summary.pendingOutCents, 0);
  assert.equal(summary.pendingInCents, 0);
  assert.equal(summary.billing[0].amount_cents, 13900);
  assert.equal(summary.billing[0].wallet_cents, 0);
  assert.equal(summary.billing[0].bank_cents, 13900);
});

test('7 $139 bill wallet $40 / bank $99 contributes $40 Pending Out', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [
      transfer({
        id: 'bill-wallet',
        amount_cents: 4000,
        source_payment_method_id: WALLET_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        idempotency_key: `billing-2026-09-${FREEDOM}-wallet`,
        provider_metadata: {
          collection_contract: 'tenant-collection-v2',
          checksops_period: '2026-09',
          checksops_leg: 'wallet',
          checksops_payment_id: 'occ-1',
        },
      }),
      transfer({
        id: 'bill-bank',
        amount_cents: 9900,
        source_payment_method_id: BANK_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        idempotency_key: `billing-2026-09-${FREEDOM}-bank`,
        provider_metadata: {
          collection_contract: 'tenant-collection-v2',
          checksops_period: '2026-09',
          checksops_leg: 'ach_debit',
          checksops_payment_id: 'occ-1',
        },
      }),
    ],
    occurrences: [{
      id: 'occ-1',
      tenant_id: FREEDOM,
      amount_cents: 13900,
      billing_period: '2026-09',
      occurrence_kind: 'monthly_subscription',
      status: 'submitted',
    }],
  });
  assert.equal(summary.pendingOutCents, 4000);
  assert.equal(summary.pendingInCents, 0);
  assert.equal(summary.billing[0].amount_cents, 13900);
  assert.equal(summary.billing[0].wallet_cents, 4000);
  assert.equal(summary.billing[0].bank_cents, 9900);
});

test('8 $139 bill wallet $139 / bank $0 contributes $139 Pending Out', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [transfer({
      amount_cents: 13900,
      source_payment_method_id: WALLET_PM,
      destination_payment_method_id: CHECKSOPS_PM,
      idempotency_key: `billing-2026-09-${FREEDOM}-wallet`,
      provider_metadata: { collection_contract: 'tenant-collection-v2', checksops_leg: 'wallet' },
    })],
  });
  assert.equal(summary.pendingOutCents, 13900);
  assert.equal(summary.billing[0].wallet_cents, 13900);
  assert.equal(summary.billing[0].bank_cents, 0);
});

test('9 pending bank → wallet funding is Pending In', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    methods,
    transfers: [transfer({
      amount_cents: 500,
      description: 'Balance funding',
      source_payment_method_id: LOCAL_BANK_ROW,
      destination_payment_method_id: WALLET_PM,
      leg_role: 'wallet_funding',
    })],
  });
  assert.equal(summary.pendingInCents, 500);
  assert.equal(summary.pendingOutCents, 0);
});

test('10 completed transfer is excluded from pending totals', () => {
  const row = classifyWalletRelativeTransfer({
    transfer: transfer({ status: 'completed' }),
    tenantWalletPaymentMethodId: WALLET_PM,
  });
  assert.equal(row.kind, 'neither');
  assert.equal(row.pending, false);
});

test('11 failed/canceled transfer is excluded from pending totals', () => {
  for (const status of ['failed', 'canceled', 'cancelled']) {
    const row = classifyWalletRelativeTransfer({
      transfer: transfer({ status }),
      tenantWalletPaymentMethodId: WALLET_PM,
    });
    assert.equal(row.kind, 'neither', status);
  }
});

test('12 unrelated tenant transfer is excluded', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [transfer({ tenant_id: OTHER, amount_cents: 99900 })],
  });
  assert.equal(summary.pendingInCents, 0);
  assert.equal(summary.pendingOutCents, 0);
});

test('13 local and provider representations of the same transfer count once', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [
      transfer({ id: 'local', provider_transfer_id: 'prov-1', amount_cents: 500 }),
      transfer({ id: 'provider-copy', provider_transfer_id: 'prov-1', amount_cents: 500 }),
    ],
  });
  assert.equal(summary.pendingInCents, 500);
});

test('14 billing activity still displays the total bill when the bank leg is excluded from Pending Out', () => {
  const billing = buildBillingActivity({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    occurrences: [{
      id: 'occ-sept',
      tenant_id: FREEDOM,
      amount_cents: 13900,
      billing_period: '2026-09',
      occurrence_kind: 'monthly_subscription',
      status: 'due',
    }],
    transfers: [transfer({
      amount_cents: 13900,
      source_payment_method_id: BANK_PM,
      destination_payment_method_id: CHECKSOPS_PM,
      provider_metadata: {
        collection_contract: 'tenant-collection-v2',
        checksops_payment_id: 'occ-sept',
        checksops_period: '2026-09',
        checksops_leg: 'ach_debit',
      },
    })],
  });
  assert.equal(billing[0].amount_cents, 13900);
  assert.equal(billing[0].wallet_cents, 0);
  assert.equal(billing[0].bank_cents, 13900);
});

test('15 funding breakdown displays wallet + bank correctly', () => {
  const billing = buildBillingActivity({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    occurrences: [{
      id: 'occ-split',
      tenant_id: FREEDOM,
      amount_cents: 13900,
      billing_period: '2026-09',
      occurrence_kind: 'monthly_subscription',
      status: 'submitted',
    }],
    transfers: [
      transfer({
        id: 'w',
        amount_cents: 4000,
        source_payment_method_id: WALLET_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        provider_metadata: { collection_contract: 'tenant-collection-v2', checksops_payment_id: 'occ-split', checksops_leg: 'wallet' },
      }),
      transfer({
        id: 'b',
        amount_cents: 9900,
        source_payment_method_id: BANK_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        provider_metadata: { collection_contract: 'tenant-collection-v2', checksops_payment_id: 'occ-split', checksops_leg: 'ach_debit' },
      }),
    ],
  });
  assert.equal(billing[0].wallet_cents, 4000);
  assert.equal(billing[0].bank_cents, 9900);
  assert.equal(billing[0].amount_cents, 13900);
});

test('Freedom $5 + $139 reproduces the $144 bug as $5 in / $0 out', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    methods,
    tenantName: 'Freedom Adjustment',
    transfers: [
      transfer({
        id: 'five',
        amount_cents: 500,
        description: 'Balance funding',
        leg_role: 'wallet_funding',
        source_payment_method_id: BANK_PM,
        destination_payment_method_id: WALLET_PM,
      }),
      transfer({
        id: 'bill',
        amount_cents: 13900,
        description: 'ChecksOps subscription 2026-09 bank',
        leg_role: 'ach_debit',
        source_payment_method_id: BANK_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        provider_metadata: { collection_contract: 'tenant-collection-v2', checksops_period: '2026-09' },
      }),
    ],
  });
  assert.equal(summary.pendingInCents, 500);
  assert.equal(summary.pendingOutCents, 0);
  assert.notEqual(summary.pendingOutCents, 14400);
});

test('other tenant billing and wallet do not leak into this tenant', () => {
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: WALLET_PM,
    transfers: [
      transfer({
        tenant_id: OTHER,
        amount_cents: 4000,
        source_payment_method_id: WALLET_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        idempotency_key: `billing-2026-09-${OTHER}-wallet`,
        provider_metadata: { collection_contract: 'tenant-collection-v2', checksops_leg: 'wallet' },
      }),
      transfer({
        tenant_id: OTHER,
        amount_cents: 9900,
        source_payment_method_id: BANK_PM,
        destination_payment_method_id: CHECKSOPS_PM,
        idempotency_key: `billing-2026-09-${OTHER}-bank`,
      }),
    ],
    occurrences: [{
      id: 'other-occ',
      tenant_id: OTHER,
      amount_cents: 13900,
      billing_period: '2026-09',
      occurrence_kind: 'monthly_subscription',
      status: 'submitted',
    }],
  });
  assert.equal(summary.pendingInCents, 0);
  assert.equal(summary.pendingOutCents, 0);
  assert.equal(summary.billing.length, 0);
});

test('dedupe helper keeps the first provider id', () => {
  const rows = dedupeTransfers([
    transfer({ id: 'a', provider_transfer_id: 'p' }),
    transfer({ id: 'b', provider_transfer_id: 'p' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'a');
});
