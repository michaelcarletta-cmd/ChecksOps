/**
 * Settings Bank Account / Stakeholder status must follow Moov-linked
 * last four and verification, not placeholder chk_acct.
 * Fixtures only. No provider writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountLastFour,
  decorateStakeholderBank,
  formatAccountLastFour,
  isPlaceholderAccountNumber,
  resolveStakeholderVerificationStatus,
} from '../../src/lib/payments/stakeholderBankDisplay.ts';
import {
  interpretMoovBankStatus,
  nextStakeholderVerification,
  sandboxScopedStakeholder,
  stakeholderPatchFromBank,
} from '../functions/api/providers/parity/moov-stakeholder-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('placeholder chk_acct is not a real last four', () => {
  assert.equal(isPlaceholderAccountNumber('0000000000'), true);
  assert.equal(isPlaceholderAccountNumber(null), true);
  assert.equal(accountLastFour({ chk_acct: '0000000000' }), null);
  assert.equal(formatAccountLastFour({ chk_acct: '0000000000' }), 'Account pending');
  assert.equal(accountLastFour({ chk_acct: '0000000000', provider_last_four: '4573' }), '4573');
  assert.equal(formatAccountLastFour({ chk_acct: '', bank_last_four: '4573' }), '••••4573');
});

test('Freedom operating card uses Moov last four instead of Account pending', () => {
  const row = decorateStakeholderBank({
    id: 'freedom-operating',
    nickname: 'Freedom Adjustment (payment account)',
    custname: 'Freedom Adjustment',
    account_type: 'operating',
    origin: 'provider_connected',
    chk_acct: null,
    verification_status: 'verified',
  }, {
    tenantBank: { bank_last_four: '4573', bank_name: 'Wells Fargo', bank_connection_status: 'connected' },
    methods: [{ last_four: '4573', verification_status: 'verified', connection_status: 'connected' }],
  });
  assert.equal(row.display_last_four, '4573');
  assert.equal(row.display_last_four_label, '••••4573');
  assert.equal(row.verification_status, 'verified');
});

test('Michael shows Bank verified when the linked Moov recipient is ready', () => {
  const row = decorateStakeholderBank({
    id: 'michael-homeowner',
    nickname: 'michael1',
    custname: 'Michael Carletta',
    account_type: 'homeowner',
    chk_acct: '0000000000',
    verification_status: 'unverified',
  }, {
    recipients: [{
      id: 'recipient-michael',
      stakeholder_account_id: 'michael-homeowner',
      onboarding_status: 'ready',
      provider_last_four: '8891',
    }],
    methods: [{
      external_recipient_id: 'recipient-michael',
      last_four: '8891',
      verification_status: 'verified',
      connection_status: 'connected',
    }],
  });
  assert.equal(row.verification_status, 'verified');
  assert.equal(row.display_last_four_label, '••••8891');
});

test('tenant bank connected does not verify a third-party stakeholder', () => {
  const row = decorateStakeholderBank({
    id: 'michael-homeowner',
    account_type: 'homeowner',
    chk_acct: '0000000000',
    verification_status: 'unverified',
  }, {
    tenantBank: { bank_last_four: '4573', bank_connection_status: 'connected' },
    methods: [{ last_four: '4573', verification_status: 'verified', external_recipient_id: null }],
  });
  assert.equal(row.verification_status, 'unverified');
  assert.equal(row.display_last_four, null);
});

test('admin override and already-verified local status are not downgraded', () => {
  assert.equal(resolveStakeholderVerificationStatus({
    verification_status: 'admin_override',
    method_verification_status: 'pending',
  }), 'admin_override');
  assert.equal(nextStakeholderVerification('verified', 'pending'), 'verified');
  assert.equal(nextStakeholderVerification('unverified', 'verified'), 'verified');
});

test('Moov verified bank patches last four and verification onto the stakeholder', () => {
  const patch = stakeholderPatchFromBank(
    { verification_status: 'unverified', chk_acct: '0000000000' },
    { status: 'verified', lastFourAccountNumber: '8891', bankName: 'Wells Fargo', bankAccountID: 'bank-1' },
  );
  assert.equal(patch.verification_status, 'verified');
  assert.equal(patch.provider_last_four, '8891');
  assert.equal(patch.provider_bank_name, 'Wells Fargo');
  assert.equal(interpretMoovBankStatus({ status: 'pending' }, { status: 'successful' }), 'verified');
});

test('sandbox sync does not target production-environment stakeholder rows', () => {
  assert.equal(sandboxScopedStakeholder({ provider_environment: 'production' }, 'sandbox'), false);
  assert.equal(sandboxScopedStakeholder({ provider_environment: 'sandbox' }, 'sandbox'), true);
  assert.equal(sandboxScopedStakeholder({}, 'sandbox'), true);
});

test('Settings and moov-sync source use the Moov-linked resolver', () => {
  const operating = readFileSync(path.join(ROOT, 'src/components/settings/TenantBankAccountSettings.tsx'), 'utf8');
  const stakeholders = readFileSync(path.join(ROOT, 'src/components/disbursement/StakeholderAccountSettings.tsx'), 'utf8');
  const sync = readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/moov-functions.mjs'), 'utf8');
  const edge = readFileSync(path.join(ROOT, 'supabase/functions/moov-sync/index.ts'), 'utf8');
  assert.match(operating, /decorateStakeholderBank/);
  assert.match(operating, /provider_last_four/);
  assert.match(operating, /display_last_four_label/);
  assert.doesNotMatch(operating, /acct\.chk_acct \? `••••\$\{acct\.chk_acct\.slice\(-4\)\}` : "Account pending"/);
  assert.match(stakeholders, /decorateStakeholderBank/);
  assert.match(stakeholders, /external_payment_recipients/);
  assert.match(sync, /applyMoovBanksToStakeholders/);
  assert.match(sync, /syncLinkedStakeholderBanks/);
  assert.match(edge, /applyTenantBanksToOperatingStakeholders/);
  assert.match(edge, /syncLinkedStakeholderBanks/);
});
