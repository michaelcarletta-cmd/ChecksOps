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

test('reconcile persists bank status onto the matching stakeholder and refetch stays distinct from identity', async () => {
  const store = new Map();
  const STAKE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  store.set(STAKE, {
    id: STAKE,
    tenant_id: TENANT,
    verification_status: 'unverified',
    provider: 'moov',
    provider_account_id: 'acct_homeowner',
    provider_bank_account_id: null,
    provider_last_four: null,
    provider_bank_name: null,
    verified_at: null,
  });
  store.set(STAKE_B, {
    id: STAKE_B,
    tenant_id: TENANT,
    verification_status: 'pending',
    provider: 'moov',
    provider_account_id: 'acct_other',
    provider_bank_account_id: null,
    provider_last_four: null,
    provider_bank_name: null,
    verified_at: null,
  });
  const client = {
    query: async (sql, params = []) => {
      if (String(sql).includes('UPDATE public.stakeholder_accounts')) {
        const row = store.get(params[0]);
        assert.ok(row, 'must update the targeted stakeholder id');
        assert.equal(params[5], TENANT);
        row.verification_status = params[1];
        row.provider_bank_account_id = params[2] || row.provider_bank_account_id;
        row.provider_last_four = params[3] || row.provider_last_four;
        row.provider_bank_name = params[4] || row.provider_bank_name;
        if (params[1] === 'verified') row.verified_at = row.verified_at || '2026-09-30T00:00:00.000Z';
        store.set(row.id, { ...row });
        return { rows: [store.get(row.id)] };
      }
      return { rows: [] };
    },
  };
  const synced = await reconcileStakeholderBankStatuses(client, {
    tenantId: TENANT,
    stakeholders: [...store.values()],
    fetchAccount: async (accountId) => {
      if (accountId === 'acct_homeowner') {
        return { profile: { individual: { verification: { status: 'verified' } } } };
      }
      return { verification: { status: 'pending' } };
    },
    fetchBanks: async (accountId) => {
      if (accountId === 'acct_homeowner') {
        return [{
          bankAccountID: 'bank_homeowner',
          verificationStatus: 'verified',
          lastFourAccountNumber: '9911',
          bankName: 'Isolated Bank',
        }];
      }
      return [{ verificationStatus: 'pending' }];
    },
  });
  const homeowner = synced.find((row) => row.id === STAKE);
  const other = synced.find((row) => row.id === STAKE_B);
  assert.equal(homeowner.verification_status, 'verified');
  assert.equal(homeowner.identity_status, 'verified');
  assert.equal(homeowner.conflated, false);
  assert.equal(other.verification_status, 'pending');
  assert.equal(other.identity_status, 'pending');

  const refetched = store.get(STAKE);
  const refetchedOther = store.get(STAKE_B);
  assert.equal(refetched.verification_status, 'verified');
  assert.equal(refetched.provider_bank_account_id, 'bank_homeowner');
  assert.equal(refetched.provider_last_four, '9911');
  assert.equal(refetchedOther.verification_status, 'pending');
  assert.equal(Object.hasOwn(refetched, 'identity_status'), false);
  assert.equal(homeowner.identity_status, 'verified');
  assert.notEqual(refetched.verification_status, undefined);
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
