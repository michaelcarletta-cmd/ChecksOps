import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTenantPaymentLedgerRows,
  computeRetainedProfit,
  dedupeFinancialMovements,
  filterRowsBySettlementDate,
  incomingSettledRows,
  isFailedOrVoidStatus,
  isIncompleteStatus,
  isSettledMoneyStatus,
  ownCheckReceivedTotal,
  recipientAggregateKey,
  resolveRecipientTenantId,
  revenueTotals,
  settlementDateIso,
  type LedgerPaymentRow,
} from "../src/lib/payments/tenantPaymentAccuracy.ts";
import { aggregateRecipientRows } from "../src/lib/taxYtdSummary.ts";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPLIT_ID = "split-ab-9000";
const PROVIDER_ID = "moov-transfer-ab-9000";

const checkA = { id: "check-a", amount: 10000, status: "deposited" };
const splitAtoB = {
  id: SPLIT_ID,
  amount: 9000,
  status: "settled",
  created_at: "2025-12-20T12:00:00.000Z",
  settled_at: "2026-01-15T18:00:00.000Z",
  recipient_name: "Tenant B LLC",
  recipient_type: "contractor",
  recipient_tenant_id: TENANT_B,
  moov_transfer_id: PROVIDER_ID,
  stakeholder_accounts: {
    id: "stake-b",
    nickname: "Tenant B LLC",
    custname: "Tenant B LLC",
    account_type: "contractor",
    tenant_id: TENANT_A,
  },
};

const incomingForB = {
  id: SPLIT_ID,
  amount: 9000,
  settled_at: "2026-01-15T18:00:00.000Z",
  created_at: "2025-12-20T12:00:00.000Z",
  recipient_name: "Tenant B LLC",
  sender_name: "Tenant A LLC",
  tenant_id: TENANT_A,
  check_number: "1001",
  carrier_name: "Acme",
};

const matchingTransfer = {
  id: "transfer-copy",
  tenant_id: TENANT_A,
  destination_tenant_id: TENANT_B,
  amount_cents: 900000,
  status: "completed",
  completed_at: "2026-01-15T18:00:00.000Z",
  created_at: "2025-12-20T12:00:00.000Z",
  provider_transfer_id: PROVIDER_ID,
  leg_role: "payout",
};

test("Profit stays Received − settled Paid for the $10,000 → $9,000 A→B example", () => {
  const aRows = buildTenantPaymentLedgerRows({
    outgoingSplits: [splitAtoB],
    incomingReceived: [],
    payerTransfers: [matchingTransfer],
  }, TENANT_A);
  const a = revenueTotals({ ownChecks: [checkA], movements: aRows });
  assert.equal(a.totalIncoming, 10000);
  assert.equal(a.totalOutgoing, 9000);
  assert.equal(a.profit, 1000);
  assert.deepEqual(computeRetainedProfit(10000, 9000), {
    totalIncoming: 10000,
    totalOutgoing: 9000,
    profit: 1000,
  });
});

test("Tenant B sees the same split id received from A and does not invent a copy", () => {
  const bRows = buildTenantPaymentLedgerRows({
    outgoingSplits: [],
    incomingReceived: [incomingForB],
    payerTransfers: [],
  }, TENANT_B);
  const incoming = incomingSettledRows(bRows);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].id, SPLIT_ID);
  assert.equal(incoming[0].direction, "incoming");
  assert.equal(incoming[0].source, "funds_received");
  assert.equal(incoming[0].amount, 9000);
  assert.equal(incoming[0].recipient_name, "Tenant A LLC");
  const b = revenueTotals({ ownChecks: [], movements: bRows });
  assert.equal(b.totalIncoming, 9000);
  assert.equal(b.totalOutgoing, 0);
  assert.equal(b.profit, 9000);
});

test("same provider transfer in splits and payment_transfers is counted once", () => {
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [splitAtoB],
    incomingReceived: [],
    payerTransfers: [matchingTransfer],
  }, TENANT_A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "disbursement_split");
  assert.equal(rows[0].id, SPLIT_ID);
  assert.equal(rows[0].amount, 9000);
});

test("incoming RPC row and payer split share one id after dedupe", () => {
  const rows = dedupeFinancialMovements(buildTenantPaymentLedgerRows({
    outgoingSplits: [splitAtoB],
    incomingReceived: [incomingForB],
    payerTransfers: [matchingTransfer],
  }, TENANT_A));
  const sameId = rows.filter((r) => r.id === SPLIT_ID);
  assert.equal(sameId.length, 1);
});

test("payer stakeholder_accounts.tenant_id is never treated as the recipient tenant", () => {
  assert.equal(resolveRecipientTenantId({
    recipient_tenant_id: TENANT_A,
    payer_tenant_id: TENANT_A,
    stakeholder_tenant_id: TENANT_A,
  }), null);
  assert.equal(resolveRecipientTenantId({
    recipient_tenant_id: TENANT_B,
    payer_tenant_id: TENANT_A,
    stakeholder_tenant_id: TENANT_A,
  }), TENANT_B);
  assert.equal(resolveRecipientTenantId({
    destination_tenant_id: TENANT_B,
    payer_tenant_id: TENANT_A,
    stakeholder_tenant_id: TENANT_A,
  }), TENANT_B);
  const key = recipientAggregateKey({
    payer_tenant_id: TENANT_A,
    recipient_tenant_id: null,
    stakeholder_accounts: { id: "stake-b", tenant_id: TENANT_A, account_type: "contractor" },
    recipient_name: "Tenant B LLC",
    recipient_type: "contractor",
  });
  assert.equal(key, "acct:stake-b");
});

test("wallet funding and self-destination transfers are excluded", () => {
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [],
    incomingReceived: [],
    payerTransfers: [
      {
        ...matchingTransfer,
        id: "wallet-fund",
        provider_transfer_id: "moov-wallet-1",
        destination_tenant_id: TENANT_A,
        tenant_id: TENANT_A,
        leg_role: "wallet_funding",
      },
      {
        ...matchingTransfer,
        id: "self-move",
        provider_transfer_id: "moov-self-1",
        destination_tenant_id: TENANT_A,
        tenant_id: TENANT_A,
        leg_role: "payout",
      },
      {
        ...matchingTransfer,
        id: "fee",
        provider_transfer_id: "moov-fee-1",
        is_facilitator_fee: true,
      },
    ],
  }, TENANT_A);
  assert.equal(rows.length, 0);
});

test("pending, failed, returned, and voided money are excluded from settled totals", () => {
  assert.equal(isIncompleteStatus("submitted"), true);
  assert.equal(isIncompleteStatus("pending"), true);
  assert.equal(isSettledMoneyStatus("settled"), true);
  assert.equal(isSettledMoneyStatus("completed"), true);
  assert.equal(isFailedOrVoidStatus("failed"), true);
  assert.equal(isFailedOrVoidStatus("returned"), true);
  assert.equal(isFailedOrVoidStatus("voided"), true);
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [
      { ...splitAtoB, id: "pending", status: "pending", moov_transfer_id: "p1" },
      { ...splitAtoB, id: "submitted", status: "submitted", moov_transfer_id: "p2" },
      { ...splitAtoB, id: "failed", status: "failed", moov_transfer_id: "p3" },
      { ...splitAtoB, id: "returned", status: "returned", moov_transfer_id: "p4" },
    ],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  const totals = revenueTotals({ ownChecks: [checkA], movements: rows });
  assert.equal(rows.some((r) => r.id === "pending"), false);
  assert.equal(rows.find((r) => r.id === "submitted")?.status, "submitted");
  assert.equal(totals.totalOutgoing, 0);
  assert.equal(ownCheckReceivedTotal([{ amount: 10, status: "pending" }]), 0);
});

test("month/year filters use settlement date for settled money", () => {
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [splitAtoB],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  const jan2026 = filterRowsBySettlementDate(rows, {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-01-31T23:59:59.999Z"),
  });
  const dec2025 = filterRowsBySettlementDate(rows, {
    from: new Date("2025-12-01T00:00:00.000Z"),
    to: new Date("2025-12-31T23:59:59.999Z"),
  });
  const year2026 = filterRowsBySettlementDate(rows, {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-12-31T23:59:59.999Z"),
  });
  assert.equal(jan2026.length, 1);
  assert.equal(dec2025.length, 0);
  assert.equal(year2026.length, 1);
  assert.equal(settlementDateIso(rows[0]), "2026-01-15T18:00:00.000Z");
});

test("tax year grouping uses settled_at and durable tenant identity", () => {
  const rows = aggregateRecipientRows({
    year: 2026,
    payments: [{
      created_at: "2025-12-20T12:00:00.000Z",
      settled_at: "2026-01-15T18:00:00.000Z",
      amount: 9000,
      recipient_name: "Tenant B LLC",
      recipient_type: "contractor",
      recipient_tenant_id: TENANT_B,
      tenant_id: TENANT_A,
      stakeholder_accounts: {
        id: "stake-b",
        nickname: "Tenant B crew",
        account_type: "contractor",
        tenant_id: TENANT_A,
      },
    }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `tenant:${TENANT_B}`);
  assert.equal(rows[0].total, 9000);
  assert.equal(rows[0].monthly[0], 9000);
  const wrongYear = aggregateRecipientRows({
    year: 2025,
    payments: [{
      created_at: "2025-12-20T12:00:00.000Z",
      settled_at: "2026-01-15T18:00:00.000Z",
      amount: 9000,
      recipient_tenant_id: TENANT_B,
      tenant_id: TENANT_A,
      recipient_name: "Tenant B LLC",
    }],
  });
  assert.equal(wrongYear.length, 0);
});

test("self-destination A→A split is excluded; A→B stays Paid", () => {
  const selfSplit = {
    ...splitAtoB,
    id: "split-aa-self",
    recipient_tenant_id: TENANT_A,
    recipient_name: "Tenant A LLC",
    moov_transfer_id: "moov-self-aa",
    stakeholder_accounts: {
      id: "stake-a",
      nickname: "Tenant A LLC",
      tenant_id: TENANT_A,
      account_type: "operating",
    },
  };
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [selfSplit, splitAtoB],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  assert.equal(rows.some((r) => r.id === "split-aa-self"), false);
  assert.equal(rows.filter((r) => r.id === SPLIT_ID).length, 1);
  const totals = revenueTotals({ ownChecks: [checkA], movements: rows });
  assert.equal(totals.totalIncoming, 10000);
  assert.equal(totals.totalOutgoing, 9000);
  assert.equal(totals.profit, 1000);
});

test("A→B with identical company names is included when tenant IDs differ", () => {
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [{
      ...splitAtoB,
      recipient_name: "Acme Restoration",
      stakeholder_accounts: {
        id: "stake-b",
        nickname: "Acme Restoration",
        custname: "Acme Restoration",
        tenant_id: TENANT_A,
        account_type: "contractor",
      },
    }],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SPLIT_ID);
  assert.equal(rows[0].recipient_tenant_id, TENANT_B);
  assert.equal(revenueTotals({ ownChecks: [checkA], movements: rows }).profit, 1000);
});

test("two legitimate separate A→B payments remain two payments", () => {
  const rows = buildTenantPaymentLedgerRows({
    outgoingSplits: [
      { ...splitAtoB, id: "pay-1", moov_transfer_id: "moov-1" },
      { ...splitAtoB, id: "pay-2", moov_transfer_id: "moov-2" },
    ],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  assert.equal(rows.length, 2);
  const totals = revenueTotals({ ownChecks: [checkA], movements: rows });
  assert.equal(totals.totalIncoming, 10000);
  assert.equal(totals.totalOutgoing, 18000);
  assert.equal(totals.profit, -8000);
});

test("tax aggregate skips A→A and keeps A→B even when names match", () => {
  const rows = aggregateRecipientRows({
    year: 2026,
    payments: [
      {
        settled_at: "2026-01-15T18:00:00.000Z",
        amount: 5000,
        recipient_name: "Acme Restoration",
        recipient_tenant_id: TENANT_A,
        tenant_id: TENANT_A,
      },
      {
        settled_at: "2026-01-15T18:00:00.000Z",
        amount: 9000,
        recipient_name: "Acme Restoration",
        recipient_tenant_id: TENANT_B,
        tenant_id: TENANT_A,
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `tenant:${TENANT_B}`);
  assert.equal(rows[0].total, 9000);
});

test("display name/type metadata edits do not change Received, Paid, or Profit", () => {
  const beforeSplit = {
    id: "acct-split",
    amount: 9000,
    status: "settled",
    created_at: "2026-01-15T00:00:00.000Z",
    settled_at: "2026-01-15T00:00:00.000Z",
    recipient_name: "Jean Lindner",
    recipient_type: "contractor",
    recipient_tenant_id: null,
    moov_transfer_id: "moov-keep",
    stakeholder_accounts: {
      id: "11111111-1111-4111-8111-111111111111",
      nickname: "Jean Lindner",
      account_type: "contractor",
      tenant_id: TENANT_A,
    },
  };
  const afterSplit = {
    ...beforeSplit,
    stakeholder_accounts: {
      ...beforeSplit.stakeholder_accounts,
      nickname: "Jean L.",
      account_type: "subcontractor",
    },
  };
  const before = revenueTotals({
    ownChecks: [checkA],
    movements: buildTenantPaymentLedgerRows({
      outgoingSplits: [beforeSplit],
      incomingReceived: [],
      payerTransfers: [],
    }, TENANT_A),
  });
  const after = revenueTotals({
    ownChecks: [checkA],
    movements: buildTenantPaymentLedgerRows({
      outgoingSplits: [afterSplit],
      incomingReceived: [],
      payerTransfers: [],
    }, TENANT_A),
  });
  assert.deepEqual(after, before);
  assert.equal(after.totalIncoming, 10000);
  assert.equal(after.totalOutgoing, 9000);
  assert.equal(after.profit, 1000);
  assert.equal(
    recipientAggregateKey({ ...afterSplit, payer_tenant_id: TENANT_A }),
    recipientAggregateKey({ ...beforeSplit, payer_tenant_id: TENANT_A }),
  );
});

test("recipient tiles and paid totals honor the same settlement-date window", () => {
  const rows: LedgerPaymentRow[] = buildTenantPaymentLedgerRows({
    outgoingSplits: [
      splitAtoB,
      {
        ...splitAtoB,
        id: "old",
        amount: 500,
        moov_transfer_id: "old-1",
        created_at: "2025-06-01T00:00:00.000Z",
        settled_at: "2025-06-02T00:00:00.000Z",
      },
    ],
    incomingReceived: [],
    payerTransfers: [],
  }, TENANT_A);
  const in2026 = filterRowsBySettlementDate(rows, {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-12-31T23:59:59.999Z"),
  }).filter((r) => r.status === "settled");
  assert.equal(in2026.reduce((s, r) => s + r.amount, 0), 9000);
  assert.equal(in2026.length, 1);
});
