import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  CLASSIFIED_PROVIDER_REJECTED,
  executeSandboxWalletFunding,
  FAILED_SANDBOX_FUNDING_INTENT_ID,
  PIPELINE_TEST_SANDBOX,
  planSandboxWalletFunding,
  resolveSandboxFundBinding,
  SANDBOX_FUNDING_DESCRIPTION,
  SANDBOX_FUNDING_PROVIDER_UUID,
  sandboxFacilitatorTransferContract,
  sandboxFundingRetryClassification,
} from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EXPECTED = PIPELINE_TEST_SANDBOX;
const tenant = { id: EXPECTED.tenantId, moov_environment: 'sandbox' };
const rds = {
  account: { provider_account_id: EXPECTED.accountId },
  wallet: { id: '34f86d69-c84a-41f9-b5f1-781ebe9b5884', provider_wallet_id: EXPECTED.walletId },
  banks: [{
    id: '4797496f-d6a3-4312-9527-04c92de1ad88',
    provider_bank_account_id: EXPECTED.bankId,
    last_four: '4321',
    bank_name: 'JPMORGAN CHASE BANK NA',
    verification_status: 'verified',
  }],
};
const live = {
  accountId: EXPECTED.accountId,
  platformAccountId: EXPECTED.platformAccountId,
  wallets: [{ id: EXPECTED.walletId, status: 'active' }],
  banks: [{
    id: EXPECTED.bankId,
    status: 'verified',
    routingNumber: EXPECTED.routingNumber,
    lastFour: EXPECTED.lastFour,
    bankName: 'JPMORGAN CHASE BANK NA',
  }],
  paymentMethods: [
    { id: EXPECTED.achDebitFundPm, type: 'ach-debit-fund', bankAccountId: EXPECTED.bankId },
    { id: EXPECTED.walletPm, type: 'moov-wallet', walletId: EXPECTED.walletId },
  ],
};
const sandboxCreds = {
  environment: 'sandbox',
  publicKey: 'sandbox-public',
  secretKey: 'sandbox-secret',
  origin: 'https://checksops.com',
  host: 'https://api.moov.io',
  apiVersion: 'v2024.01.00',
};
const failedIntent = (extra = {}) => ({
  ...planSandboxWalletFunding(resolveSandboxFundBinding({ tenant, rds, live })),
  id: FAILED_SANDBOX_FUNDING_INTENT_ID,
  status: 'failed',
  provider_transfer_id: null,
  provider_idempotency_key: SANDBOX_FUNDING_PROVIDER_UUID,
  provider_metadata: {
    post_attempted: true,
    post_outcome: 'failed',
    do_not_retry: true,
    provider_idempotency_key: SANDBOX_FUNDING_PROVIDER_UUID,
  },
  ...extra,
});

test('classified 403 with no provider object is retryable; unknown/timeout are not', () => {
  const classified = sandboxFundingRetryClassification(failedIntent());
  assert.equal(classified.retryable, true);
  assert.equal(classified.classification, CLASSIFIED_PROVIDER_REJECTED);
  const unknown = sandboxFundingRetryClassification(failedIntent({
    status: 'unknown',
    provider_metadata: { post_attempted: true, post_outcome: 'unknown' },
  }));
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.classification, 'unknown_no_retry');
  const timeout = sandboxFundingRetryClassification({
    provider_transfer_id: null,
    provider_metadata: { post_attempted: true },
  });
  assert.equal(timeout.retryable, false);
  const exists = sandboxFundingRetryClassification({
    provider_transfer_id: '11111111-2222-4333-8444-555555555555',
    provider_metadata: { post_attempted: true, post_outcome: 'failed' },
  });
  assert.equal(exists.retryable, false);
});

test('dark classified retry holds POST on the facilitator path with the same UUID', async () => {
  const binding = resolveSandboxFundBinding({ tenant, rds, live, amountCents: 1 });
  assert.equal(binding.providerIdempotencyKey, SANDBOX_FUNDING_PROVIDER_UUID);
  const contract = sandboxFacilitatorTransferContract(binding);
  assert.equal(contract.endpoint, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.equal(contract.sourcePaymentMethodId, EXPECTED.achDebitFundPm);
  assert.equal(contract.destinationPaymentMethodId, EXPECTED.walletPm);
  assert.equal(contract.amount.value, 1);
  assert.equal(contract.description, SANDBOX_FUNDING_DESCRIPTION);
  let called = 0;
  const dark = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    binding,
    intent: failedIntent(),
    transferPostEnabled: false,
    fetchImpl: async () => {
      called += 1;
      throw new Error('provider_must_not_be_called');
    },
  });
  assert.equal(dark.outcome, 'transfer_post_held');
  assert.equal(dark.transfer_post_held, true);
  assert.equal(dark.post_account_path, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.equal(dark.provider_idempotency_key, SANDBOX_FUNDING_PROVIDER_UUID);
  assert.equal(dark.retry_classification, CLASSIFIED_PROVIDER_REJECTED);
  assert.equal(called, 0);
});

test('armed classified retry POSTs facilitator path once and keeps unknown blocked', async () => {
  const binding = resolveSandboxFundBinding({ tenant, rds, live });
  const calls = [];
  const posted = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    binding,
    intent: failedIntent(),
    transferPostEnabled: true,
    fetchImpl: async (url, opts = {}) => {
      if (String(url).includes('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't' }) };
      }
      calls.push({ path: String(url), method: opts.method, body: JSON.parse(opts.body), idempotency: opts.headers?.['X-Idempotency-Key'] });
      return {
        ok: true,
        status: 201,
        headers: { get: (name) => (String(name).toLowerCase() === 'x-request-id' ? 'req-m79g' : null) },
        text: async () => JSON.stringify({ transferID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'pending' }),
      };
    },
  });
  assert.equal(posted.outcome, 'posted');
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, new RegExp(`/accounts/${EXPECTED.platformAccountId}/transfers`));
  assert.doesNotMatch(calls[0].path, new RegExp(`/accounts/${EXPECTED.accountId}/transfers`));
  assert.equal(calls[0].body.source.paymentMethodID, EXPECTED.achDebitFundPm);
  assert.equal(calls[0].body.destination.paymentMethodID, EXPECTED.walletPm);
  assert.equal(calls[0].body.amount.value, 1);
  assert.equal(calls[0].body.description, SANDBOX_FUNDING_DESCRIPTION);
  assert.equal(calls[0].idempotency, SANDBOX_FUNDING_PROVIDER_UUID);
  assert.equal(posted.requestId, 'req-m79g');
  assert.doesNotMatch(JSON.stringify(calls[0].body), new RegExp(KNOWN_APPROVED_MOOV.freedom.achDebitFundPm));

  const blocked = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    binding,
    intent: failedIntent({
      status: 'unknown',
      provider_metadata: { post_attempted: true, post_outcome: 'unknown' },
    }),
    transferPostEnabled: true,
    fetchImpl: async () => { throw new Error('retry_forbidden'); },
  });
  assert.equal(blocked.outcome, 'unknown_no_retry');
  assert.equal(blocked.liveProviderCalled, false);
});

test('M7.9G runner reuses the failed intent, never creates a replacement, and disarms sandbox only', () => {
  const src = sourceOf('../providers/oneshot/m79g-run.mjs');
  assert.match(src, /b18a96d7-4415-4df8-992f-70d5a17365a9/);
  assert.match(src, /72f44c1a-5ee4-4601-9e4b-3ca54fbc3935/);
  assert.match(src, /36b79957-ce7a-4ca7-a68f-30986c9e47bb/);
  assert.match(src, /setSandboxPostFlag\('true'\)/);
  assert.match(src, /setSandboxPostFlag\('false'\)/);
  assert.match(src, /finally/);
  assert.match(src, /verify_funding_intent/);
  assert.match(src, /update_funding_intent/);
  assert.match(src, /CLASSIFIED_PROVIDER_REJECTED/);
  assert.match(src, /sandboxFundingRetryClassification/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
});
