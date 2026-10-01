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
  applyMoovBankVerificationEvent,
  interpretMoovBankStatus,
  nextStakeholderVerification,
  resolveStakeholderVerificationTargets,
  sandboxScopedStakeholder,
  shouldApplyBankVerificationEvent,
  stakeholderPatchFromBank,
} from '../functions/api/providers/parity/moov-stakeholder-sync.mjs';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';

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

test('Michael shows Bank verified when the unique recipient email is Moov-ready', () => {
  const row = decorateStakeholderBank({
    id: 'michael-homeowner',
    nickname: 'michael1',
    custname: 'Michael Carletta',
    account_type: 'homeowner',
    chk_acct: '0000000000',
    provider_account_id: null,
    verification_status: 'unverified',
    verification_recipient_email: 'michael@example.com',
  }, {
    recipients: [{
      id: 'recipient-michael',
      stakeholder_account_id: null,
      email: 'michael@example.com',
      onboarding_status: 'ready',
      provider_last_four: '8891',
      provider_account_id: 'moov-michael',
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

test('ambiguous recipient emails do not verify a third-party stakeholder', () => {
  const row = decorateStakeholderBank({
    id: 'michael-homeowner',
    account_type: 'homeowner',
    verification_status: 'unverified',
    verification_recipient_email: 'shared@example.com',
  }, {
    recipients: [
      { id: 'r1', email: 'shared@example.com', onboarding_status: 'ready', provider_last_four: '1111' },
      { id: 'r2', email: 'shared@example.com', onboarding_status: 'ready', provider_last_four: '2222' },
    ],
  });
  assert.equal(row.verification_status, 'unverified');
  assert.equal(row.display_last_four, null);
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

test('Moov verified webhook attaches a Settings row that has no provider_account_id', () => {
  const michael = {
    id: 'michael-homeowner',
    account_type: 'homeowner',
    provider_account_id: null,
    verification_status: 'unverified',
    verification_recipient_email: 'michael@example.com',
  };
  const targets = resolveStakeholderVerificationTargets({
    providerAccountId: 'moov-michael',
    bankAccountID: 'bank-1',
    stakeholders: [michael],
    recipients: [{
      id: 'recipient-michael',
      stakeholder_account_id: 'michael-homeowner',
      provider_account_id: 'moov-michael',
    }],
  });
  assert.deepEqual(targets.stakeholderIds, ['michael-homeowner']);
});

test('unique recipient email attaches an unlinked Settings stakeholder', () => {
  const targets = resolveStakeholderVerificationTargets({
    providerAccountId: 'moov-michael',
    stakeholders: [{
      id: 'michael-homeowner',
      provider_account_id: null,
      verification_recipient_email: 'michael@example.com',
    }],
    recipients: [{
      id: 'recipient-michael',
      stakeholder_account_id: null,
      provider_account_id: 'moov-michael',
      email: 'michael@example.com',
    }],
  });
  assert.deepEqual(targets.stakeholderIds, ['michael-homeowner']);
  assert.deepEqual(targets.recipientLinks, [{
    recipientId: 'recipient-michael',
    stakeholderId: 'michael-homeowner',
  }]);
});

test('tenant operating verification does not verify a third-party Settings row', () => {
  const targets = resolveStakeholderVerificationTargets({
    providerAccountId: 'moov-freedom',
    isTenantOperatingAccount: true,
    stakeholders: [
      { id: 'freedom-operating', account_type: 'operating', provider_account_id: null },
      { id: 'michael-homeowner', account_type: 'homeowner', provider_account_id: null },
    ],
    recipients: [],
  });
  assert.deepEqual(targets.stakeholderIds, ['freedom-operating']);
});

test('bankAccount.updated events apply verification and transfer events do not', () => {
  assert.equal(shouldApplyBankVerificationEvent('bankAccount.updated', {
    bankAccountID: 'bank-1',
    status: 'verified',
  }), true);
  assert.equal(shouldApplyBankVerificationEvent('transfer.updated', {
    transferID: 'tr-1',
    status: 'completed',
  }), false);
});

function verificationClient({
  stakeholder = {
    id: 'michael-homeowner',
    tenant_id: 'freedom-tenant',
    provider_account_id: null,
    verification_status: 'unverified',
    verified_at: null,
    provider_last_four: null,
    provider_bank_name: null,
    provider_bank_account_id: null,
    provider_environment: 'sandbox',
    account_type: 'homeowner',
    origin: null,
    verification_recipient_email: 'michael@example.com',
  },
  recipient = {
    id: 'recipient-michael',
    tenant_id: 'freedom-tenant',
    stakeholder_account_id: 'michael-homeowner',
    provider_account_id: 'moov-michael',
    email: 'michael@example.com',
    onboarding_status: 'awaiting_bank',
    provider_last_four: null,
    provider_bank_name: null,
    environment: 'sandbox',
    provider_bank_account_id: null,
  },
} = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM public.external_payment_recipients/.test(sql) && /SELECT id, tenant_id, stakeholder_account_id/.test(sql)) {
        return { rows: [recipient] };
      }
      if (/FROM public.payment_provider_methods/.test(sql) && /SELECT id, provider_account_id/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM public.payment_provider_accounts/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM public.stakeholder_accounts/.test(sql)) {
        return { rows: [stakeholder] };
      }
      return { rows: [] };
    },
  };
}

test('Moov verified event writes Settings verification without a pre-linked provider_account_id', async () => {
  const client = verificationClient();
  const result = await applyMoovBankVerificationEvent(client, {
    environment: 'sandbox',
    providerAccountId: 'moov-michael',
    tenantId: 'freedom-tenant',
    bank: {
      bankAccountID: 'bank-1',
      bankName: 'Wells Fargo',
      lastFourAccountNumber: '8891',
      status: 'verified',
    },
    sandboxOnly: true,
  });
  assert.equal(result.updated, 1);
  const update = client.queries.find((q) => /UPDATE public.stakeholder_accounts/.test(q.sql));
  assert.equal(update.params[1], 'moov-michael');
  assert.equal(update.params[4], '8891');
  assert.equal(update.params[5], 'verified');
});

test('sandbox webhook apply writes the linked Settings stakeholder from a bankAccount event', async () => {
  const client = verificationClient();
  const applied = await applyMoovWebhook(client, {
    type: 'bankAccount.updated',
    accountID: 'moov-michael',
    data: {
      bankAccountID: 'bank-1',
      bankName: 'Wells Fargo',
      lastFourAccountNumber: '8891',
      status: 'verified',
    },
  }, { mappedTenantId: 'freedom-tenant' });
  assert.equal(applied.applied, true);
  assert.ok(applied.mutations.includes('stakeholder_accounts'));
  const update = client.queries.find((q) => /UPDATE public.stakeholder_accounts/.test(q.sql));
  assert.equal(update.params[5], 'verified');
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
  const webhook = readFileSync(path.join(ROOT, 'supabase/functions/moov-webhook/index.ts'), 'utf8');
  const webhookApply = readFileSync(path.join(ROOT, 'aws/functions/api/providers/webhook-apply.mjs'), 'utf8');
  const bankVerify = readFileSync(path.join(ROOT, 'supabase/functions/moov-recipient-bank-verify/index.ts'), 'utf8');
  assert.match(webhook, /applyMoovBankVerificationEvent/);
  assert.match(webhookApply, /applyMoovBankVerificationEvent/);
  assert.match(bankVerify, /applyMoovBankVerificationEvent/);
  assert.doesNotMatch(stakeholders, /adminOverride/);
  assert.doesNotMatch(stakeholders, /> Override</);
  assert.doesNotMatch(operating, /adminOverride/);
  assert.doesNotMatch(operating, /> Override</);
});
