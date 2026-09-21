import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createMemoryPayoutStore } from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  ensureSandboxRecipientAchCredit,
  executeSandboxWalletDisbursement,
  persistSandboxPayoutIntent,
  planSandboxWalletDisbursement,
  resolveSandboxPayoutBinding,
  SANDBOX_PAYOUT_AMOUNT_CENTS,
  SANDBOX_PAYOUT_DESCRIPTION,
  SANDBOX_PAYOUT_PROVIDER_UUID,
  sandboxFacilitatorPayoutContract,
  sandboxPayoutRetryClassification,
  sandboxWalletDisbursementIdempotencyKey,
} from '../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EXPECTED = PIPELINE_TEST_SANDBOX;
const RECIPIENT_ACH_CREDIT_PM = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

const tenant = {
  id: EXPECTED.tenantId,
  name: 'ChecksOps Pipeline Test',
  moov_environment: 'sandbox',
};
const rds = {
  account: { id: '7f8dfda0-473d-4873-b1da-bfa8fd133113', provider_account_id: EXPECTED.accountId },
  wallet: { id: '34f86d69-c84a-41f9-b5f1-781ebe9b5884', provider_wallet_id: EXPECTED.walletId, available_cents: 1 },
  recipient: { id: 'aaaaaaaa-1111-4222-8333-444444444444', provider_account_id: EXPECTED.recipientAccountId },
  banks: [
    {
      id: '4797496f-d6a3-4312-9527-04c92de1ad88',
      provider_bank_account_id: EXPECTED.bankId,
      provider_payment_method_id: EXPECTED.achDebitFundPm,
      last_four: '4321',
      verification_status: 'verified',
    },
    {
      id: 'dddddddd-eeee-4fff-8000-111111111111',
      provider_bank_account_id: EXPECTED.recipientBankId,
      last_four: '8901',
    },
  ],
};
const live = {
  accountId: EXPECTED.accountId,
  platformAccountId: EXPECTED.platformAccountId,
  walletAvailableCents: 1,
  wallets: [{ id: EXPECTED.walletId, status: 'active', availableCents: 1 }],
  payerPaymentMethods: [
    { id: EXPECTED.achDebitFundPm, type: 'ach-debit-fund', bankAccountId: EXPECTED.bankId },
    { id: EXPECTED.walletPm, type: 'moov-wallet', walletId: EXPECTED.walletId },
  ],
  recipientAccountId: EXPECTED.recipientAccountId,
  recipientBanks: [{ id: EXPECTED.recipientBankId, status: 'verified' }],
  recipientPaymentMethods: [
    { id: RECIPIENT_ACH_CREDIT_PM, type: 'ach-credit-standard', bankAccountId: EXPECTED.recipientBankId },
  ],
  payerCapabilities: [{ capability: 'send-funds', status: 'enabled' }],
};
const sandboxCreds = {
  environment: 'sandbox',
  publicKey: 'sandbox-public',
  secretKey: 'sandbox-secret',
  origin: 'https://checksops.com',
  host: 'https://api.moov.io',
  apiVersion: 'v2024.01.00',
};

const bindingOf = (overrides = {}) => resolveSandboxPayoutBinding({
  tenant,
  rds,
  live,
  amountCents: 1,
  ...overrides,
});

test('sandbox payout writer binds wallet PM to recipient ACH-credit and ignores browser environment', () => {
  const binding = bindingOf({ clientHints: { environment: 'production', accountId: EXPECTED.accountId, destinationPaymentMethodId: EXPECTED.recipientBankId } });
  assert.equal(binding.ok, true);
  assert.equal(binding.environment, 'sandbox');
  assert.equal(binding.accountId, EXPECTED.accountId);
  assert.equal(binding.walletId, EXPECTED.walletId);
  assert.equal(binding.sourcePaymentMethodId, EXPECTED.walletPm);
  assert.equal(binding.destinationPaymentMethodId, RECIPIENT_ACH_CREDIT_PM);
  assert.notEqual(binding.destinationPaymentMethodId, EXPECTED.recipientBankId);
  assert.notEqual(binding.sourcePaymentMethodId, EXPECTED.achDebitFundPm);
  assert.equal(binding.recipientAccountId, EXPECTED.recipientAccountId);
  assert.equal(binding.amountCents, SANDBOX_PAYOUT_AMOUNT_CENTS);
  assert.equal(binding.post_account_path, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.equal(binding.browserAuthoritative, false);
  assert.equal(binding.sendFunds, true);
  assert.match(binding.idempotencyKey, new RegExp(EXPECTED.tenantId));
  assert.match(binding.idempotencyKey, /sandbox/);
  assert.match(binding.idempotencyKey, /wallet_disbursement/);
  assert.match(binding.idempotencyKey, /cents:1/);
  assert.doesNotMatch(binding.idempotencyKey, /wallet_funding/);
  assert.equal(binding.providerIdempotencyKey, SANDBOX_PAYOUT_PROVIDER_UUID);
  assert.match(SANDBOX_PAYOUT_PROVIDER_UUID, /^[0-9a-f-]{36}$/i);
});

test('sandbox payout writer refuses production IDs, funding PM as source, and insufficient wallet', () => {
  const prodHint = bindingOf({
    clientHints: { recipientAccountId: KNOWN_APPROVED_MOOV.recipient.moovAccountId },
  });
  assert.equal(prodHint.ok, false);
  assert.equal(prodHint.error, 'production_ids_blocked');

  const amount = bindingOf({ amountCents: 2 });
  assert.equal(amount.ok, false);
  assert.equal(amount.error, 'amount_not_one_cent');

  const emptyWallet = bindingOf({
    live: { ...live, walletAvailableCents: 0, wallets: [{ id: EXPECTED.walletId, availableCents: 0 }] },
  });
  assert.equal(emptyWallet.ok, false);
  assert.equal(emptyWallet.error, 'wallet_available_insufficient');

  const missingPm = bindingOf({
    live: { ...live, recipientPaymentMethods: [] },
  });
  assert.equal(missingPm.ok, false);
  assert.equal(missingPm.error, 'sandbox_recipient_pm_missing');

  const noSend = bindingOf({
    live: { ...live, payerCapabilities: [{ capability: 'collect-funds', status: 'enabled' }] },
  });
  assert.equal(noSend.ok, false);
  assert.equal(noSend.error, 'send_funds_not_enabled');
});

test('durable sandbox wallet_disbursement intent reuses one idempotency key', async () => {
  const binding = bindingOf();
  const planned = planSandboxWalletDisbursement(binding);
  const store = createMemoryPayoutStore();
  const first = await persistSandboxPayoutIntent(store, planned);
  const second = await persistSandboxPayoutIntent(store, planned);
  assert.equal(first.created, true);
  assert.equal(second.reused, true);
  assert.equal(store.inserts.filter((kind) => kind === 'wallet_disbursement').length, 1);
  assert.equal(first.intent.amount_cents, 1);
  assert.equal(first.intent.environment, 'sandbox');
  assert.equal(first.intent.leg_role, 'wallet_disbursement');
  assert.equal(
    sandboxWalletDisbursementIdempotencyKey({
      tenantId: EXPECTED.tenantId,
      environment: 'sandbox',
      operation: 'sandbox_wallet_to_recipient',
      leg: 'wallet_disbursement',
      amountCents: 1,
    }),
    planned.idempotency_key,
  );
});

test('dark sandbox payout holds POST when Lambda sandbox flag is false', async () => {
  const binding = bindingOf();
  let called = 0;
  const result = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    productionPublicKey: 'prod-public',
    productionSecretKey: 'prod-secret',
    binding,
    intent: planSandboxWalletDisbursement(binding),
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
    fetchImpl: async () => {
      called += 1;
      throw new Error('provider_must_not_be_called');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'transfer_post_held');
  assert.equal(result.transfer_post_held, true);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.post_account_path, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.equal(called, 0);
});

test('armed sandbox payout POSTs facilitator path once and does not retry unknown or 4xx', async () => {
  const binding = bindingOf();
  const contract = sandboxFacilitatorPayoutContract(binding);
  assert.equal(contract.endpoint, `/accounts/${EXPECTED.platformAccountId}/transfers`);
  assert.equal(contract.sourcePaymentMethodId, EXPECTED.walletPm);
  assert.equal(contract.destinationPaymentMethodId, RECIPIENT_ACH_CREDIT_PM);
  assert.equal(contract.amount.value, 1);
  assert.equal(contract.description, SANDBOX_PAYOUT_DESCRIPTION);
  const calls = [];
  const posted = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    productionPublicKey: 'prod-public',
    binding,
    intent: planSandboxWalletDisbursement(binding),
    transferPostEnabled: true,
    productionTransferPostEnabled: false,
    fetchImpl: async (url, opts = {}) => {
      if (String(url).includes('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sandbox-token' }) };
      }
      calls.push({
        path: String(url),
        method: opts.method,
        idempotency: opts.headers?.['X-Idempotency-Key'],
        body: opts.body ? JSON.parse(opts.body) : null,
      });
      return {
        ok: true,
        status: 201,
        headers: { get: (name) => (String(name).toLowerCase() === 'x-request-id' ? 'req-m710' : null) },
        text: async () => JSON.stringify({
          transferID: '11111111-2222-4333-8444-555555555555',
          status: 'pending',
          amount: { currency: 'USD', value: 1 },
        }),
      };
    },
  });
  assert.equal(posted.outcome, 'posted');
  assert.equal(posted.liveProviderPosted, true);
  assert.equal(posted.provider_transfer_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(posted.requestId, 'req-m710');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].path, new RegExp(`/accounts/${EXPECTED.platformAccountId}/transfers`));
  assert.doesNotMatch(calls[0].path, new RegExp(`/accounts/${EXPECTED.accountId}/transfers`));
  assert.equal(calls[0].idempotency, SANDBOX_PAYOUT_PROVIDER_UUID);
  assert.equal(calls[0].body.source.paymentMethodID, EXPECTED.walletPm);
  assert.equal(calls[0].body.destination.paymentMethodID, RECIPIENT_ACH_CREDIT_PM);
  assert.notEqual(calls[0].body.source.paymentMethodID, EXPECTED.achDebitFundPm);
  assert.notEqual(calls[0].body.destination.paymentMethodID, EXPECTED.walletPm);
  assert.equal(calls[0].body.amount.value, 1);

  const unknown = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    binding,
    intent: planSandboxWalletDisbursement(binding),
    transferPostEnabled: true,
    fetchImpl: async (url) => {
      if (String(url).includes('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sandbox-token' }) };
      }
      const error = new Error('fetch failed');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.doNotRetry, true);
  const blockedUnknown = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    binding,
    intent: {
      ...planSandboxWalletDisbursement(binding),
      provider_metadata: { post_attempted: true, post_outcome: 'unknown' },
    },
    transferPostEnabled: true,
    fetchImpl: async () => { throw new Error('retry_forbidden'); },
  });
  assert.equal(blockedUnknown.outcome, 'unknown_no_retry');
  assert.equal(blockedUnknown.liveProviderCalled, false);
  const classified = sandboxPayoutRetryClassification({
    status: 'failed',
    provider_metadata: { post_attempted: true, post_outcome: 'failed' },
  });
  assert.equal(classified.retryable, false);
  const blockedFailed = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    binding,
    intent: {
      ...planSandboxWalletDisbursement(binding),
      status: 'failed',
      provider_metadata: { post_attempted: true, post_outcome: 'failed' },
    },
    transferPostEnabled: true,
    fetchImpl: async () => { throw new Error('retry_forbidden'); },
  });
  assert.equal(blockedFailed.outcome, 'unknown_no_retry');
  assert.equal(blockedFailed.liveProviderCalled, false);
});

test('sandbox payout writer refuses production credentials and production POST flag', async () => {
  const binding = bindingOf();
  const creds = await executeSandboxWalletDisbursement({
    credentials: { environment: 'production', publicKey: 'p', secretKey: 's' },
    binding,
    transferPostEnabled: true,
  });
  assert.equal(creds.ok, false);
  assert.equal(creds.error, 'production_credentials_refused');
  assert.equal(creds.liveProviderCalled, false);
  const prodFlag = await executeSandboxWalletDisbursement({
    credentials: sandboxCreds,
    binding,
    transferPostEnabled: true,
    productionTransferPostEnabled: true,
  });
  assert.equal(prodFlag.ok, false);
  assert.equal(prodFlag.error, 'production_post_flag_refused');
  assert.equal(prodFlag.liveProviderCalled, false);
});

test('recipient ACH-credit ensure requests collect-funds on the sandbox payee and never POSTs transfers', async () => {
  const calls = [];
  const methods = [];
  const result = await ensureSandboxRecipientAchCredit({
    credentials: sandboxCreds,
    delayMs: 0,
    attempts: 3,
    sleepImpl: async () => {},
    fetchImpl: async (url, opts = {}) => {
      const path = String(url);
      if (path.includes('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sandbox-token' }) };
      }
      calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
      if (path.includes('/capabilities') && opts.method === 'POST') {
        return { ok: true, status: 201, text: async () => JSON.stringify({ capability: JSON.parse(opts.body).capability, status: 'enabled' }) };
      }
      if (path.includes('/payment-methods')) {
        const payload = methods.length ? [{
          paymentMethodID: RECIPIENT_ACH_CREDIT_PM,
          paymentMethodType: 'ach-credit-standard',
          bankAccountID: EXPECTED.recipientBankId,
        }] : [];
        methods.push('listed');
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
      throw new Error(`unexpected:${path}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.destinationPaymentMethodId, RECIPIENT_ACH_CREDIT_PM);
  assert.equal(result.liveProviderPostedTransfer, false);
  assert.equal(calls.some((row) => row.method === 'POST' && row.path.includes('/transfers')), false);
  assert.equal(calls.filter((row) => row.method === 'POST' && row.path.includes('/capabilities')).length, 2);
  assert.match(calls.find((row) => row.method === 'POST').path, new RegExp(`/accounts/${EXPECTED.recipientAccountId}/capabilities`));
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(EXPECTED.accountId));
});

test('M7.10 runner arms sandbox only, posts wallet→recipient once, and never funds or arms production', () => {
  const src = sourceOf('../providers/oneshot/m710-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  const writer = sourceOf('../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs');
  assert.match(src, new RegExp(EXPECTED.tenantId));
  assert.match(src, new RegExp(EXPECTED.accountId));
  assert.match(src, new RegExp(EXPECTED.walletId));
  assert.match(src, new RegExp(EXPECTED.walletPm));
  assert.match(src, new RegExp(EXPECTED.recipientAccountId));
  assert.match(src, new RegExp(EXPECTED.recipientBankId));
  assert.match(src, /setSandboxPostFlag\('true'\)/);
  assert.match(src, /setSandboxPostFlag\('false'\)/);
  assert.match(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED = value/);
  assert.match(src, /finally/);
  assert.match(src, /ensureSandboxRecipientAchCredit/);
  assert.match(src, /persist_payout_intent/);
  assert.match(src, /wallet_disbursement/);
  assert.match(src, /STOP_FOR_REVIEW/);
  assert.match(src, /do not retry|Do not retry|doNotRetry/i);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.match(oneshot, /persist_payout_intent/);
  assert.match(oneshot, /update_payout_intent/);
  assert.match(oneshot, /verify_payout_intent/);
  assert.match(oneshot, /wallet_disbursement/);
  assert.match(oneshot, /refused_production_tenant/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_TRANSFER_POST_ENABLED/);
  assert.match(writer, /ensureSandboxRecipientAchCredit/);
  assert.match(writer, /transfer_post_held/);
  assert.match(writer, /funding_pm_refused_as_payout_source/);
  assert.match(writer, /production_credentials_refused/);
  assert.equal(typeof executeSandboxWalletDisbursement, 'function');
  assert.equal(typeof persistSandboxPayoutIntent, 'function');
});
