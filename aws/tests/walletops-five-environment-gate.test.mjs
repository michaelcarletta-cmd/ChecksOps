/**
 * Read-only gate: does environment=sandbox on the recovered Freedom $5
 * block production WalletOps on checksops.com?
 *
 * Uses the accepted WalletOps query/filter/activity path.
 * Fixtures only. No provider, database, SPA, or Lambda writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveWalletOpsEnvironment, selectPaymentWallet } from '../../src/lib/payments/selectPaymentWallet.ts';
import { summarizeWalletOps } from '../../src/lib/payments/walletRelativeTransfers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FIVE_ROW = '63f892d9-a0f4-4f62-9373-262d6c361c90';
const FIVE = '9f9df312-32a9-4999-ace9-fc2b00669c75';
const LOCAL_BANK = '8eb5b26e-6f66-435c-a578-880fb7fc14dd';
const BANK_PM = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const WALLET_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';
const CHECKSOPS_PM = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const BILL = 'ab2895c9-2ba8-4c21-a818-7f83abdb068c';
const BILL_PROVIDER = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';

const hooksSrc = fs.readFileSync(path.join(ROOT, 'src/hooks/useWalletOps.ts'), 'utf8');
const pageSrc = fs.readFileSync(path.join(ROOT, 'src/pages/WalletOps.tsx'), 'utf8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
const rlsSrc = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/12_final_select_policies.sql'), 'utf8');
const draftSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/db.mjs'), 'utf8');
const schemaSrc = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260727224957_ed6a1a02-de8d-46a3-ab51-8e563ccf9e3a.sql'),
  'utf8',
);

const TRANSFER_SELECT = 'id, tenant_id, amount_cents, status, provider_status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee, source_payment_method_id, destination_payment_method_id, provider_metadata, provider_transfer_id, idempotency_key, wallet_id';

function transferQueryBlock() {
  const start = hooksSrc.indexOf('.from("payment_transfers")');
  const end = hooksSrc.indexOf('.from("payment_wallets")', start);
  assert.ok(start >= 0 && end > start, 'transfer query block missing');
  return hooksSrc.slice(start, end);
}

function applyWalletOpsTransferQuery(table, tenantId, limit = 25) {
  const selected = TRANSFER_SELECT.split(', ');
  return table
    .filter((row) => row.tenant_id === tenantId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map((row) => {
      const out = {};
      for (const key of selected) out[key] = row[key];
      return out;
    });
}

function buildRecentActivity({ classified, billing }) {
  const billingTransferKeys = new Set(
    billing.flatMap((row) => row.transfer_ids.map((id) => String(id))),
  );
  return classified
    .filter((row) => {
      if (row.billing) return false;
      const providerId = String(row.transfer.provider_transfer_id || '');
      return !billingTransferKeys.has(providerId) && !billingTransferKeys.has(row.transfer.id);
    })
    .map((row) => ({
      id: row.transfer.id,
      title: row.purpose,
      kind: row.kind,
      credit: row.isWalletDestination && !row.isWalletSource,
      amountCents: row.amountCents,
      status: row.transfer.provider_status || row.transfer.status,
      from: row.from_label,
      to: row.to_label,
    }));
}

const recoveredFive = {
  id: FIVE_ROW,
  tenant_id: FREEDOM,
  environment: 'sandbox',
  amount_cents: 500,
  status: 'pending',
  provider_status: 'pending',
  speed: 'standard',
  selected_rail: null,
  description: 'Balance funding',
  created_at: '2026-09-29T15:44:35.327Z',
  completed_at: null,
  leg_role: 'wallet_funding',
  is_facilitator_fee: false,
  source_payment_method_id: LOCAL_BANK,
  destination_payment_method_id: null,
  provider_metadata: {
    checksops_kind: 'wallet_funding',
    source_payment_method_id: BANK_PM,
    destination_payment_method_id: WALLET_PM,
  },
  provider_transfer_id: FIVE,
  idempotency_key: `wallet-fund:${FREEDOM}:operating:500`,
  wallet_id: '473ceaca-3534-467b-8d92-49baa53f6c68',
};

const production139 = {
  id: BILL,
  tenant_id: FREEDOM,
  environment: 'production',
  amount_cents: 13900,
  status: 'submitted',
  provider_status: 'pending',
  speed: 'standard',
  selected_rail: null,
  description: 'ChecksOps subscription 2026-09 bank',
  created_at: '2026-09-29T22:46:17.662Z',
  completed_at: null,
  leg_role: 'ach_debit',
  is_facilitator_fee: false,
  source_payment_method_id: LOCAL_BANK,
  destination_payment_method_id: CHECKSOPS_PM,
  provider_metadata: {
    collection_contract: 'tenant-collection-v2',
    checksops_period: '2026-09',
    checksops_payment_id: '72b622f9-b68f-4032-a971-a854dbcfbf57',
  },
  provider_transfer_id: BILL_PROVIDER,
  idempotency_key: `billing-2026-09-${FREEDOM}-bank`,
  wallet_id: null,
};

const otherTenantSandbox = {
  ...recoveredFive,
  id: 'other-sandbox',
  tenant_id: OTHER,
  provider_transfer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  amount_cents: 99900,
};

const methods = [{
  id: LOCAL_BANK,
  tenant_id: FREEDOM,
  provider_payment_method_id: '7a78a544-340d-46fd-a4a4-228661374da7',
  last_four: '4573',
  bank_name: 'WELLS FARGO BANK',
  rail_payment_method_ids: { 'ach-debit-fund': BANK_PM },
}];

const wallets = [
  {
    id: '473ceaca-3534-467b-8d92-49baa53f6c68',
    tenant_id: FREEDOM,
    wallet_type: 'operating',
    environment: 'production',
    provider_payment_method_id: WALLET_PM,
  },
  {
    id: 'a854c4b1-07f6-42c0-9da9-6c2e3538ebe1',
    tenant_id: FREEDOM,
    wallet_type: 'operating',
    environment: 'sandbox',
    provider_payment_method_id: WALLET_PM,
  },
];

function runProductionWalletOps(table) {
  const walletEnvironment = resolveWalletOpsEnvironment({ hostname: 'checksops.com' });
  const queried = applyWalletOpsTransferQuery(table, FREEDOM);
  const rows = queried.filter((row) => !row.tenant_id || row.tenant_id === FREEDOM);
  const wallet = selectPaymentWallet(wallets, {
    tenantId: FREEDOM,
    walletType: 'operating',
    environment: walletEnvironment,
  });
  const summary = summarizeWalletOps({
    tenantId: FREEDOM,
    tenantWalletPaymentMethodId: wallet?.provider_payment_method_id || null,
    transfers: rows,
    methods,
    occurrences: [{
      id: '72b622f9-b68f-4032-a971-a854dbcfbf57',
      tenant_id: FREEDOM,
      amount_cents: 13900,
      billing_period: '2026-09',
      occurrence_kind: 'monthly_subscription',
      status: 'due',
    }],
    tenantName: 'Freedom Adjustment',
  });
  return {
    walletEnvironment,
    queried,
    selectedHasEnvironment: queried.some((row) => Object.prototype.hasOwnProperty.call(row, 'environment')),
    returnedIds: queried.map((row) => row.id),
    fiveReturned: queried.some((row) => row.id === FIVE_ROW),
    pendingInCents: summary.pendingInCents,
    pendingOutCents: summary.pendingOutCents,
    activity: buildRecentActivity({ classified: summary.transfers, billing: summary.billing }),
    fiveClassified: summary.transfers.find((row) => row.transfer.id === FIVE_ROW) || null,
  };
}

test('transfer query is tenant_id only and does not select environment', () => {
  const block = transferQueryBlock();
  assert.match(block, /\.from\("payment_transfers"\)/);
  assert.match(block, new RegExp(TRANSFER_SELECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(block, /\.eq\("tenant_id", tenantId!\)/);
  assert.doesNotMatch(block, /\.eq\("environment"/);
  assert.doesNotMatch(block, /environment/);
  assert.match(block, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(block, /\.limit\(limit\)/);
});

test('wallet query is the one that filters environment; transfers do not', () => {
  const walletStart = hooksSrc.indexOf('.from("payment_wallets")');
  const walletBlock = hooksSrc.slice(walletStart, hooksSrc.indexOf('.from("payment_provider_methods")', walletStart));
  assert.match(walletBlock, /\.eq\("environment", walletEnvironment\)/);
  assert.equal(resolveWalletOpsEnvironment({ hostname: 'checksops.com' }), 'production');
});

test('/data/query and AWS client do not inject an environment filter', () => {
  assert.match(dataSrc, /await runSelect\(client, body\)/);
  assert.doesNotMatch(dataSrc, /filters\.push\(\{[^}]*environment/);
  assert.match(clientSrc, /state\.filters\.push\(\{ column, op: "eq", value \}\)/);
  assert.match(rlsSrc, /aws_select_payment_transfers[\s\S]*aws_can_access_tenant\(tenant_id\)/);
  assert.doesNotMatch(
    rlsSrc.slice(rlsSrc.indexOf('aws_select_payment_transfers'), rlsSrc.indexOf('aws_select_payment_wallet_ledger')),
    /environment/,
  );
});

test('actual recovered $5 row is returned and classified on checksops.com', () => {
  const result = runProductionWalletOps([recoveredFive, production139, otherTenantSandbox]);
  assert.equal(result.walletEnvironment, 'production');
  assert.equal(result.selectedHasEnvironment, false);
  assert.equal(result.fiveReturned, true);
  assert.deepEqual(result.returnedIds.sort(), [FIVE_ROW, BILL].sort());
  assert.equal(result.pendingInCents, 500);
  assert.equal(result.pendingOutCents, 0);
  assert.equal(result.fiveClassified?.kind, 'pending_in');
  assert.equal(result.fiveClassified?.purpose, 'Wallet Funding');
  const fiveActivity = result.activity.find((row) => row.id === FIVE_ROW);
  assert.ok(fiveActivity);
  assert.equal(fiveActivity.title, 'Wallet Funding');
  assert.equal(fiveActivity.credit, true);
  assert.equal(fiveActivity.amountCents, 500);
  assert.equal(fiveActivity.status, 'pending');
  assert.match(fiveActivity.from, /4573/);
  assert.match(fiveActivity.to, /Wallet/);
});

test('a genuine extra sandbox test transfer would also be returned — leakage is structural', () => {
  const extraSandbox = {
    ...recoveredFive,
    id: 'sandbox-test-only',
    provider_transfer_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    amount_cents: 100,
    description: 'sandbox-only test',
    created_at: '2026-09-30T00:00:00.000Z',
    provider_metadata: {
      source_payment_method_id: BANK_PM,
      destination_payment_method_id: WALLET_PM,
    },
  };
  const result = runProductionWalletOps([recoveredFive, production139, extraSandbox]);
  assert.equal(result.returnedIds.includes('sandbox-test-only'), true);
  assert.equal(result.pendingInCents, 600);
});

test('schema default is sandbox; AWS walletFund insert hardcodes sandbox', () => {
  assert.match(schemaSrc, /environment text NOT NULL DEFAULT 'sandbox'/);
  assert.match(schemaSrc, /UNIQUE INDEX IF NOT EXISTS payment_transfers_provider_id_uniq[\s\S]*\(provider, environment, provider_transfer_id\)/);
  assert.match(draftSrc, /VALUES \(\$1::uuid, 'moov', 'sandbox', 'ready'/);
});

test('WalletOps activity keeps non-billing classified transfers, including this $5', () => {
  assert.match(pageSrc, /classifiedTransfers/);
  assert.match(pageSrc, /if \(row\.billing\) return false/);
  assert.doesNotMatch(pageSrc, /kind === "neither"/);
  assert.match(pageSrc, /Pending in/);
  assert.match(pageSrc, /pendingIn/);
});
