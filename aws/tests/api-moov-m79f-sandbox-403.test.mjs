import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  executeSandboxWalletFunding,
  PIPELINE_TEST_SANDBOX,
  planSandboxWalletFunding,
  reconstructM79eFailedTransferRequest,
  resolveSandboxFundBinding,
  sandboxFacilitatorTransferContract,
  sandboxFacilitatorTransferPath,
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

test('M7.9E failed request used connected-account transfer URL, not platform facilitator', () => {
  const failed = reconstructM79eFailedTransferRequest();
  assert.equal(failed.method, 'POST');
  assert.equal(failed.apiVersion, 'v2024.01.00');
  assert.equal(failed.endpoint, `/accounts/${EXPECTED.accountId}/transfers`);
  assert.notEqual(failed.endpoint, sandboxFacilitatorTransferPath(EXPECTED.platformAccountId));
  assert.equal(failed.facilitatorAccountIdInPath, false);
  assert.equal(failed.sourcePaymentMethodId, EXPECTED.achDebitFundPm);
  assert.equal(failed.destinationPaymentMethodId, EXPECTED.walletPm);
  assert.equal(failed.amount.value, 1);
  assert.equal(failed.amount.currency, 'USD');
  assert.equal(failed.facilitatorFee, null);
  assert.match(failed.providerIdempotencyKey, /^[0-9a-f-]{36}$/i);
});

test('corrected contract posts to sandbox platform with merchant payment methods and UUID idempotency', () => {
  const binding = resolveSandboxFundBinding({ tenant, rds, live, amountCents: 1 });
  assert.equal(binding.ok, true);
  assert.equal(binding.platformAccountId, EXPECTED.platformAccountId);
  assert.notEqual(binding.platformAccountId, EXPECTED.accountId);
  assert.notEqual(binding.platformAccountId, KNOWN_APPROVED_MOOV.platform.moovAccountId);
  const contract = sandboxFacilitatorTransferContract(binding);
  assert.equal(contract.endpoint, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.deepEqual(contract.scopes, [`/accounts/${EXPECTED.platformAccountId}/transfers.write`]);
  assert.equal(contract.sourceAccount, EXPECTED.accountId);
  assert.equal(contract.destinationAccount, EXPECTED.accountId);
  assert.equal(contract.sourcePaymentMethodId, EXPECTED.achDebitFundPm);
  assert.equal(contract.destinationPaymentMethodId, EXPECTED.walletPm);
  assert.equal(contract.amount.value, 1);
  assert.equal(contract.facilitatorAccountIdInPath, true);
});

test('production platform and missing platform are refused; dark mode still posts nothing', async () => {
  const prodPlatform = resolveSandboxFundBinding({
    tenant,
    rds,
    live: { ...live, platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId },
  });
  assert.equal(prodPlatform.ok, false);
  assert.equal(prodPlatform.error, 'production_ids_blocked');
  const missing = resolveSandboxFundBinding({
    tenant,
    rds,
    live: { ...live, platformAccountId: null },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'sandbox_platform_mismatch');
  const binding = resolveSandboxFundBinding({ tenant, rds, live });
  let called = 0;
  const dark = await executeSandboxWalletFunding({
    credentials: {
      environment: 'sandbox',
      publicKey: 'sandbox-public',
      secretKey: 'sandbox-secret',
      origin: 'https://checksops.com',
      host: 'https://api.moov.io',
    },
    binding,
    intent: planSandboxWalletFunding(binding),
    transferPostEnabled: false,
    fetchImpl: async () => {
      called += 1;
      throw new Error('provider_must_not_be_called');
    },
  });
  assert.equal(dark.outcome, 'transfer_post_held');
  assert.equal(called, 0);
});

test('armed writer would POST facilitator path only and never production IDs', async () => {
  const binding = resolveSandboxFundBinding({ tenant, rds, live });
  const calls = [];
  await executeSandboxWalletFunding({
    credentials: {
      environment: 'sandbox',
      publicKey: 'sandbox-public',
      secretKey: 'sandbox-secret',
      origin: 'https://checksops.com',
      host: 'https://api.moov.io',
    },
    binding,
    intent: planSandboxWalletFunding(binding),
    transferPostEnabled: true,
    fetchImpl: async (url, opts = {}) => {
      if (String(url).includes('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't' }) };
      }
      calls.push({ path: String(url), method: opts.method, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ transferID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'pending' }),
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, new RegExp(`/accounts/${EXPECTED.platformAccountId}/transfers`));
  assert.doesNotMatch(calls[0].path, new RegExp(`/accounts/${EXPECTED.accountId}/transfers`));
  assert.doesNotMatch(JSON.stringify(calls[0].body), new RegExp(KNOWN_APPROVED_MOOV.freedom.achDebitFundPm));
  assert.equal(calls[0].body.source.paymentMethodID, EXPECTED.achDebitFundPm);
  assert.equal(calls[0].body.destination.paymentMethodID, EXPECTED.walletPm);
});

test('M7.9F runner never posts transfers, never arms flags, and never creates intents', () => {
  const src = sourceOf('../providers/oneshot/m79f-run.mjs');
  assert.match(src, /b18a96d7-4415-4df8-992f-70d5a17365a9/);
  assert.match(src, /36b79957-ce7a-4ca7-a68f-30986c9e47bb/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /reconstructM79eFailedTransferRequest/);
  assert.match(src, /sandboxFacilitatorTransferContract/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
});
