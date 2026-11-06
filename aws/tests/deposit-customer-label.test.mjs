import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEPOSIT_CUSTOMER_SELECT,
  depositCaseIds,
  depositCustomerName,
  depositPartyLabel,
} from '../../src/lib/depositCustomerLabel.ts';

// Owner, 2026-11-06: Payments & Financials "recent deposit only shows Travelers, not the customer
// name so it is hard to track". The customer is primary, the carrier secondary.

test('customer name comes from the insured rule (payees, case, claim policyholder)', () => {
  assert.equal(
    depositCustomerName({ check_payees: [{ payee_name: 'DEEN BANDHU', payee_type: 'insured' }, { payee_name: 'ABC Mortgage', payee_type: 'mortgage' }] }),
    'DEEN BANDHU',
  );
  assert.equal(depositCustomerName({ case_id: 'c1', check_payees: [] }, new Map([['c1', 'Deen Bandhu']])), 'Deen Bandhu');
  assert.equal(depositCustomerName({ claims: { policyholder_name: 'Deen Bandhu' } }), 'Deen Bandhu');
  assert.equal(depositCustomerName({ claims: [{ policyholder_name: 'Deen Bandhu' }] }), 'Deen Bandhu');
  // Untyped OCR payee that reads as a person; businesses are skipped.
  assert.equal(depositCustomerName({ check_payees: [{ payee_name: 'Deen Bandhu', payee_type: 'unknown' }] }), 'Deen Bandhu');
  assert.equal(depositCustomerName({ check_payees: [{ payee_name: 'Travelers Insurance Co', payee_type: 'unknown' }] }), null);
  assert.equal(depositCustomerName({}), null);
  assert.equal(depositCustomerName(null), null);
});

test('label prefers the customer name, with the carrier secondary', () => {
  assert.deepEqual(
    depositPartyLabel({ customerName: 'Deen Bandhu', carrierName: 'TRAVELERS', formatCarrier: (c) => c.charAt(0) + c.slice(1).toLowerCase() }),
    { primary: 'Deen Bandhu', secondary: 'Travelers' },
  );
  assert.deepEqual(
    depositPartyLabel({ customerName: 'Deen Bandhu', carrierName: 'Travelers', claimNumber: 'FC-12' }),
    { primary: 'Deen Bandhu', secondary: 'Travelers · FC-12' },
  );
});

test('falls back to the carrier (then the claim number) when there is no customer name', () => {
  assert.deepEqual(depositPartyLabel({ customerName: null, carrierName: 'Travelers' }), { primary: 'Travelers', secondary: null });
  assert.deepEqual(depositPartyLabel({ customerName: '  ', carrierName: 'Travelers', claimNumber: 'FC-12' }), { primary: 'Travelers', secondary: 'FC-12' });
  assert.deepEqual(depositPartyLabel({ claimNumber: 'FC-12' }), { primary: 'FC-12', secondary: null });
  assert.deepEqual(depositPartyLabel({}), { primary: '—', secondary: null });
});

test('case ids are distinct and sorted; the select reads only allowlisted relations', () => {
  assert.deepEqual(depositCaseIds([{ case_id: 'b' }, { case_id: 'a' }, { case_id: 'b' }, null, {}]), ['a', 'b']);
  assert.equal(DEPOSIT_CUSTOMER_SELECT, 'case_id, claims(policyholder_name), check_payees(payee_name, payee_type)');
  const allowed = JSON.parse(readFileSync('aws/functions/api/allowed-tables.json', 'utf8'));
  const tables = Array.isArray(allowed) ? allowed : Object.values(allowed).flat();
  for (const t of ['check_intake_items', 'claims', 'check_payees', 'check_cases']) assert.ok(tables.includes(t), t);
});

test('Revenue Sources and the Payment Ledger label deposits customer first', () => {
  const revenue = readFileSync('src/components/ledger/RevenueSummary.tsx', 'utf8');
  assert.match(revenue, /DEPOSIT_CUSTOMER_SELECT/);
  assert.match(revenue, /customerName: depositCustomerName\(check, caseInsuredNames\)/);
  assert.doesNotMatch(revenue, /title: check\.freedom_claim_number \|\| displayCase\(check\.carrier_name\)/);
  const ledger = readFileSync('src/components/ledger/PaymentLedger.tsx', 'utf8');
  assert.match(ledger, /claim_id, \$\{DEPOSIT_CUSTOMER_SELECT\}/);
  assert.match(ledger, /Customer \/ Carrier/);
  assert.match(ledger, /"Check #", "Customer", "Carrier", "Amount"/);
});
