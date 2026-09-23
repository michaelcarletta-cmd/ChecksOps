import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKALT_SUBMITTED_LABEL,
  getDepositLabel,
  isCheckAltDepositLabel,
} from '../../src/lib/depositLabel.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('CheckAlt 127 / submitted / deposited labels as Submitted, never Cleared', () => {
  assert.equal(CHECKALT_SUBMITTED_LABEL, 'Submitted');
  assert.equal(getDepositLabel({
    check_stage: 'deposited',
    deposit_status: 'deposited',
    checkalt_status: 'submitted',
  }), 'Submitted');
  assert.equal(getDepositLabel({
    check_stage: 'deposited',
    checkalt_deposits: [{ status: 'submitted' }],
  }), 'Submitted');
  assert.equal(getDepositLabel({
    deposit_status: 'submitted',
    provider: 'checkalt',
  }), 'Submitted');
  assert.equal(isCheckAltDepositLabel({ checkalt_status: 'submitted' }), true);
});

test('CheckAlt pending / rejected stay accurate', () => {
  assert.equal(getDepositLabel({
    check_stage: 'deposited',
    checkalt_status: 'pending_approval',
  }), 'Pending Approval');
  assert.equal(getDepositLabel({
    check_stage: 'ready_for_deposit',
    checkalt_status: 'rejected',
  }), 'Rejected');
});

test('non-CheckAlt deposited / known cleared labels are unchanged', () => {
  assert.equal(getDepositLabel({ check_stage: 'deposited' }), 'Cleared');
  assert.equal(getDepositLabel({ deposit_status: 'cleared' }), 'Cleared');
  assert.equal(getDepositLabel({ deposit_status: 'settled' }), 'Cleared');
  assert.equal(getDepositLabel({ check_stage: 'funds_released' }), 'Funds Released');
  assert.equal(isCheckAltDepositLabel({ check_stage: 'deposited' }), false);
});

test('CheckAlt only says Cleared when local status is actually cleared', () => {
  assert.equal(getDepositLabel({
    check_stage: 'deposited',
    checkalt_status: 'cleared',
  }), 'Cleared');
});

test('ClaimLedgerCard passes CheckAlt status into getDepositLabel', () => {
  const src = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(src, /checkalt_deposits\(status\)/);
  assert.match(src, /claim-ledger-checkalt-status/);
  assert.match(src, /checkalt_status:/);
  assert.match(src, /checkAltStatusByIntake/);
});

test('display fix does not invent settlement, status 200, or Fix A', () => {
  const label = read('src/lib/depositLabel.ts');
  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  const combined = `${label}\n${card}`;
  assert.equal(/status\s*200|NUMERIC_STATUS_MAP|deposit\/process|deposit\/approve/.test(combined), false);
  assert.equal(/cleared_at\s*=/.test(combined), false);
  assert.match(label, /127 \/ Approved/);
  const amounts = read('aws/functions/api/providers/amounts.mjs');
  assert.match(amounts, /127: 'submitted'/);
  const bank = read('src/components/deposit-ops/BankDepositReconciliation.tsx');
  assert.match(bank, /row\?\.status === "cleared" && Boolean\(row\?\.cleared_at\)/);
});
