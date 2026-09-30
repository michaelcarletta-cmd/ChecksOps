import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  bankStatusFromMoovBanks,
  identityStatusFromMoovAccount,
  reconcileStakeholderBankStatuses,
} from '../functions/api/providers/parity/moov-stakeholder-status.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const STAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('bank and identity statuses stay independent', () => {
  assert.equal(bankStatusFromMoovBanks([]), 'unverified');
  assert.equal(bankStatusFromMoovBanks([{ verificationStatus: 'verified' }]), 'verified');
  assert.equal(bankStatusFromMoovBanks([{ status: 'errored' }]), 'failed');
  assert.equal(bankStatusFromMoovBanks([{ verificationStatus: 'pending' }]), 'pending');
  assert.equal(identityStatusFromMoovAccount({
    profile: { individual: { verification: { status: 'verified' } } },
  }), 'verified');
  assert.equal(identityStatusFromMoovAccount({
    verification: { status: 'unverified' },
  }), 'unverified');
  assert.notEqual(
    bankStatusFromMoovBanks([{ verificationStatus: 'unverified' }]),
    identityStatusFromMoovAccount({ verification: { status: 'verified' } }),
  );
});

test('reconcile writes bank status, never treats a provider account id as verified', async () => {
  const updates = [];
  const client = {
    query: async (sql, params) => {
      if (String(sql).includes('UPDATE public.stakeholder_accounts')) {
        updates.push({ sql, params });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const missing = await reconcileStakeholderBankStatuses(client, {
    tenantId: TENANT,
    stakeholders: [{
      id: STAKE,
      tenant_id: TENANT,
      verification_status: 'unverified',
      provider: 'moov',
      provider_account_id: null,
    }],
  });
  assert.equal(missing[0].skipped, true);
  assert.equal(missing[0].reason, 'missing_provider_account');
  assert.equal(missing[0].verification_status, 'unverified');
  assert.equal(updates.length, 0);

  const synced = await reconcileStakeholderBankStatuses(client, {
    tenantId: TENANT,
    stakeholders: [{
      id: STAKE,
      tenant_id: TENANT,
      verification_status: 'unverified',
      provider: 'moov',
      provider_account_id: 'acct_live',
      provider_bank_account_id: null,
    }],
    fetchAccount: async () => ({
      profile: { individual: { verification: { status: 'verified' } } },
    }),
    fetchBanks: async () => [{
      bankAccountID: 'bank_live',
      verificationStatus: 'verified',
      lastFourAccountNumber: '4321',
      bankName: 'Test Bank',
    }],
  });
  assert.equal(synced[0].verification_status, 'verified');
  assert.equal(synced[0].identity_status, 'verified');
  assert.equal(synced[0].bank_verified, true);
  assert.equal(synced[0].conflated, false);
  assert.equal(updates[0].params[1], 'verified');
  assert.equal(updates[0].params[2], 'bank_live');

  updates.length = 0;
  const identityOnly = await reconcileStakeholderBankStatuses(client, {
    tenantId: TENANT,
    stakeholders: [{
      id: STAKE,
      tenant_id: TENANT,
      verification_status: 'unverified',
      provider: 'moov',
      provider_account_id: 'acct_live',
    }],
    fetchAccount: async () => ({ verification: { status: 'verified' } }),
    fetchBanks: async () => [{ verificationStatus: 'unverified' }],
  });
  assert.equal(identityOnly[0].verification_status, 'unverified');
  assert.equal(identityOnly[0].identity_status, 'verified');
  assert.equal(identityOnly[0].bank_verified, false);
  assert.equal(updates[0].params[1], 'unverified');
});

test('moov-sync and stakeholder UI keep bank vs identity labels separate', () => {
  const sync = read('aws/functions/api/providers/parity/moov-functions.mjs');
  const ui = read('src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.match(sync, /reconcileStakeholderBankStatuses/);
  assert.match(sync, /identity_status: verification/);
  assert.match(ui, /Bank verified/);
  assert.match(ui, /Provider linked/);
  assert.match(ui, /A Moov account exists\. This is not bank verification/);
  assert.match(ui, /invoke\("moov-sync"/);
  assert.match(ui, /invalidateQueries\(\{ queryKey: \["stakeholder-accounts"/);
  assert.match(ui, /invalidateQueries\(\{ queryKey: \["tenant-verified-bank-accounts"\]/);
  assert.doesNotMatch(ui, /verification_status.*=.*provider_account_id \? "verified"/);
});
