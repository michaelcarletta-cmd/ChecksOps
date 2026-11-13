// Tax & 1099 includes vendors (owner, 2026-11-13: "Include vendors in the 1099 reports"): vendor payroll
// runs (payroll_runs.vendor_tenant_id, SQL 165) and check-bound sends to a vendor payee are grouped by
// vendor organization (name from tenants_public), summed per year, and listed next to stakeholders with a
// "Vendor (ChecksOps)" type. Vendors have no bank account and no TIN in ChecksOps unless the payer enters
// one under "Tax info": both show as missing, never guessed. The CSV still carries no tax identifier.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACCOUNT_TYPE_LABELS,
  LEGACY_INFORMATIONAL_1099_TYPES,
  VENDOR_ACCOUNT_MISSING,
  VENDOR_ORG_DETAIL,
  VENDOR_ORG_TYPE,
  aggregateRecipientRows,
  buildPaymentReportingCsv,
  csvContainsTin,
  vendorRecipientRowKey,
} from '../../src/lib/taxYtdSummary.ts';
import {
  fetchOrganizationSendLegs,
  sendLedgerRows,
  sendRecipientReportRows,
  sentPayments,
  vendorSendTaxPayments,
} from '../../src/lib/payments/transferFinanceRows.ts';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const taxSummary = read('src/components/ledger/TaxSummary.tsx');

const leg = (id, over = {}) => ({
  id,
  check_id: 'c1',
  leg_role: 'send_wallet',
  status: 'completed',
  amount_cents: 10000,
  created_at: '2026-03-01T10:00:00Z',
  completed_at: '2026-03-02T10:00:00Z',
  destination_tenant_id: 'V1',
  provider_metadata: { purpose: 'send', request_hash: `h-${id}`, recipient_index: 0, recipient_kind: 'vendor', recipient_id: 'V1', recipient_name: 'Acme Supply' },
  ...over,
});

test('check-bound sends: recipient_kind vendor counts; a recorded partner never; an unrecorded kind only for a vendor payee', () => {
  const legs = [
    leg('a'),
    // Same send, bank leg of the shortfall: one payment of $150.
    leg('a2', { leg_role: 'send_bank', amount_cents: 5000, provider_metadata: { ...leg('a').provider_metadata } }),
    // A partner payment to the same organization is not a vendor payment.
    leg('p', { provider_metadata: { purpose: 'send', request_hash: 'h-p', recipient_index: 0, recipient_kind: 'partner', recipient_id: 'V1', recipient_name: 'Acme Supply' } }),
    // No recorded kind: counts only when the receiving organization is a vendor payee.
    leg('u', { destination_tenant_id: 'V2', provider_metadata: { purpose: 'send', request_hash: 'h-u', recipient_index: 0 } }),
    leg('w', { destination_tenant_id: 'P9', provider_metadata: { purpose: 'send', request_hash: 'h-w', recipient_index: 0 } }),
    // Payroll legs are counted from payroll_runs, never here; not-accepted legs never.
    leg('r', { provider_metadata: { ...leg('r').provider_metadata, purpose: 'payroll' } }),
    leg('f', { status: 'failed' }),
  ];
  const names = new Map([['V1', 'Acme Supply Co'], ['V2', 'Bolt Hardware']]);
  const out = vendorSendTaxPayments(legs, { vendorTenantIds: ['v2'], names });
  assert.deepEqual(out.map((p) => [p.vendor_tenant_id, p.vendor_name, p.amount]).sort(), [
    ['V1', 'Acme Supply Co', 150],
    ['V2', 'Bolt Hardware', 100],
  ]);
  assert.deepEqual(vendorSendTaxPayments(legs).map((p) => p.vendor_tenant_id), ['V1']);
  // The name falls back to the one recorded on the leg, never a guess.
  assert.equal(vendorSendTaxPayments([leg('a')])[0].vendor_name, 'Acme Supply');
  assert.equal(vendorSendTaxPayments([leg('n', { provider_metadata: { purpose: 'send', request_hash: 'h-n', recipient_kind: 'vendor' } })])[0].vendor_name, null);
});

test('the other finance views label a vendor send as a vendor, not a partner', () => {
  const [payment] = sentPayments([leg('a')]);
  assert.equal(payment.recipientKind, 'vendor');
  assert.equal(payment.partnerTenantId, 'V1');
  assert.equal(sendLedgerRows([leg('a')])[0].recipient_type, 'vendor');
  assert.equal(sendRecipientReportRows([leg('a')])[0].acct4, 'Vendor wallet');
  // A partner send is unchanged.
  const partner = leg('p', { provider_metadata: { purpose: 'send', request_hash: 'h-p', recipient_kind: 'partner', recipient_name: 'Freedom' } });
  assert.equal(sentPayments([partner])[0].recipientKind, 'partner');
  assert.equal(sendRecipientReportRows([partner])[0].acct4, 'Partner wallet');
});

test('aggregate: one row per vendor organization, sends and payroll together, per year, next to stakeholders', () => {
  const split = { settled_at: '2026-02-10T00:00:00Z', amount: 700, stakeholder_accounts: { id: 's1', nickname: 'Pat', custname: 'Pat Co', account_type: 'contractor', chk_acct: '991234' } };
  const payrollRuns = [
    { id: 'r1', amount: 200, status: 'submitted', created_at: '2026-05-01T00:00:00Z', stakeholder_account_id: null, vendor_tenant_id: 'V1', vendor_name: 'Acme Supply Co' },
    { id: 'r2', amount: 50, status: 'failed', created_at: '2026-05-02T00:00:00Z', stakeholder_account_id: null, vendor_tenant_id: 'V1' },
    { id: 'r3', amount: 999, status: 'completed', created_at: '2025-06-30T12:00:00Z', stakeholder_account_id: null, vendor_tenant_id: 'V1' },
  ];
  const vendorPayments = [
    { vendor_tenant_id: 'v1', vendor_name: null, at: '2026-03-02T10:00:00Z', amount: 150 },
    { vendor_tenant_id: 'V3', vendor_name: 'Small Vendor', at: '2026-07-01T10:00:00Z', amount: 100 },
    { vendor_tenant_id: 'V1', vendor_name: 'Acme Supply Co', at: '2027-06-02T10:00:00Z', amount: 5000 },
  ];
  const rows = aggregateRecipientRows({ payments: [split], payrollRuns, vendorPayments, year: 2026 });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const acme = byId[vendorRecipientRowKey('V1')];
  assert.equal(acme.id, 'vendor:v1');
  assert.equal(acme.nickname, 'Acme Supply Co');
  assert.equal(acme.custname, VENDOR_ORG_DETAIL);
  assert.equal(acme.account_type, VENDOR_ORG_TYPE);
  assert.equal(acme.chk_acct, '');
  assert.equal(acme.total, 350);
  assert.equal(acme.payment_count, 2);
  assert.equal(acme.monthly[2], 150);
  assert.equal(acme.monthly[4], 200);
  assert.equal(acme.requires_1099, true);
  assert.equal(acme.needs_1099, false);
  assert.equal(byId['vendor:v3'].total, 100);
  assert.equal(byId['acct:s1'].total, 700);
  assert.equal(byId['acct:s1'].needs_1099, true);
  assert.equal(rows.length, 3);
  // The $600 informational flag applies to a vendor the same way.
  const big = aggregateRecipientRows({ vendorPayments: [{ vendor_tenant_id: 'V1', vendor_name: 'Acme', at: '2026-01-05T12:00:00Z', amount: 600 }], year: 2026 });
  assert.equal(big[0].needs_1099, true);
});

test('labels and CSV: "Vendor (ChecksOps)" type, the missing bank account shown as missing, still no TIN column', () => {
  assert.equal(ACCOUNT_TYPE_LABELS[VENDOR_ORG_TYPE], 'Vendor (ChecksOps)');
  assert.ok(LEGACY_INFORMATIONAL_1099_TYPES.includes(VENDOR_ORG_TYPE));
  const rows = aggregateRecipientRows({ vendorPayments: [{ vendor_tenant_id: 'V1', vendor_name: 'Acme Supply Co', at: '2026-01-05T12:00:00Z', amount: 650 }], year: 2026 });
  const csv = buildPaymentReportingCsv({ year: 2026, recipients: rows, monthlyTotals: rows[0].monthly, totalPaid: 650 });
  const line = csv.split('\n')[1];
  assert.match(line, /^"Acme Supply Co","Vendor · ChecksOps wallet","Vendor \(ChecksOps\)","Missing: no bank account \(ChecksOps wallet\)",/);
  assert.match(line, /"650\.00","1","YES"$/);
  assert.equal(VENDOR_ACCOUNT_MISSING, 'Missing: no bank account (ChecksOps wallet)');
  assert.equal(csvContainsTin(csv), false);
});

test('Tax & 1099 screen: reads vendor sends for the year, behind the flag, and shows the missing account', async () => {
  assert.match(taxSummary, /enabled: PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS && !!tenant\?\.id,/);
  assert.match(taxSummary, /queryFn: \(\) => fetchOrganizationSendLegs\(supabase, tenant!\.id, \{/);
  assert.match(taxSummary, /vendorTenantIds: vendorPayees\.map\(\(v\) => v\.vendor_tenant_id\),/);
  assert.match(taxSummary, /aggregateRecipientRows\(\{ payments: payments as any\[\], cashPayments: cashPayments as any\[\], payrollRuns, vendorPayments, year \}\)/);
  assert.match(taxSummary, /\{r\.account_type === VENDOR_ORG_TYPE \? " · no bank account on file" : ""\}/);
  // The TIN status of a vendor row is this tenant's own tax profile for vendor:<id> ("No TIN on file").
  assert.match(taxSummary, /taxProfileTinStatusLabel\(profileByKey\[r\.id\], profilesQueryState\)/);
  assert.match(taxSummary, /openEdit\(r\.id, r\.account_type !== VENDOR_ORG_TYPE && /);

  // The reader: this tenant's accepted send legs in the year, legs to an organization only, and names.
  const calls = [];
  const chain = (table) => ({
    filters: [],
    eq(c, v) { this.filters.push(['eq', c, v]); return this; },
    in(c, v) {
      this.filters.push(['in', c, v]);
      return table === 'tenants_public' ? Promise.resolve({ data: [{ id: 'V1', name: 'Acme Supply Co' }], error: null }) : this;
    },
    gte(c, v) { this.filters.push(['gte', c, v]); return this; },
    lte(c, v) {
      this.filters.push(['lte', c, v]);
      calls.push([table, this.filters]);
      return Promise.resolve({ data: [leg('a'), leg('s', { destination_tenant_id: null, provider_metadata: { recipient_kind: 'stakeholder' } })], error: null });
    },
  });
  const client = { from: (table) => ({ select: () => chain(table) }) };
  const { legs, names } = await fetchOrganizationSendLegs(client, 't1', { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' });
  assert.deepEqual(legs.map((l) => l.id), ['a']);
  assert.equal(names.get('V1'), 'Acme Supply Co');
  const [table, filters] = calls[0];
  assert.equal(table, 'payment_transfers');
  assert.deepEqual(filters.map((f) => `${f[0]}:${f[1]}`), ['eq:tenant_id', 'in:leg_role', 'in:status', 'gte:created_at', 'lte:created_at']);
});
