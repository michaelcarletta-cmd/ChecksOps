import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createMemoryPayoutStore } from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  executeSandboxWalletFunding,
  persistSandboxFundingIntent,
  PIPELINE_TEST_SANDBOX,
  planSandboxWalletFunding,
  resolveSandboxFundBinding,
  SANDBOX_FUNDING_AMOUNT_CENTS,
  sandboxWalletFundingIdempotencyKey,
  sandboxWalletFundingProviderIdempotency,
} from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EXPECTED = PIPELINE_TEST_SANDBOX;

const tenant = {
  id: EXPECTED.tenantId,
  name: 'ChecksOps Pipeline Test',
  moov_environment: 'sandbox',
};
const rds = {
  account: { id: '7f8dfda0-473d-4873-b1da-bfa8fd133113', provider_account_id: EXPECTED.accountId },
  wallet: { id: '34f86d69-c84a-41f9-b5f1-781ebe9b5884', provider_wallet_id: EXPECTED.walletId, available_cents: 0 },
  banks: [
    {
      id: '4797496f-d6a3-4312-9527-04c92de1ad88',
      provider_bank_account_id: EXPECTED.bankId,
      provider_payment_method_id: 'c4ceedc3-0000-4000-8000-000000000001',
      bank_name: 'JPMORGAN CHASE BANK NA',
      last_four: '4321',
      verification_status: 'verified',
    },
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111',
      provider_bank_account_id: EXPECTED.recipientBankId,
      last_four: '8901',
    },
  ],
};
const live = {
  accountId: EXPECTED.accountId,
  wallets: [{ id: EXPECTED.walletId, status: 'active', availableCents: 0 }],
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
    { id: 'c4ceedc3-0000-4000-8000-000000000001', type: 'ach-credit-standard', bankAccountId: EXPECTED.bankId },
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

const bindingOf = (overrides = {}) => resolveSandboxFundBinding({
  tenant,
  rds,
  live,
  amountCents: 1,
  ...overrides,
});

test('sandbox writer binds Pipeline Test objects from tenant/RDS/live and ignores browser environment', () => {
  const binding = bindingOf({ clientHints: { environment: 'production', accountId: EXPECTED.accountId } });
  assert.equal(binding.ok, true);
  assert.equal(binding.environment, 'sandbox');
  assert.equal(binding.accountId, EXPECTED.accountId);
  assert.equal(binding.bankId, EXPECTED.bankId);
  assert.equal(binding.sourcePaymentMethodId, EXPECTED.achDebitFundPm);
  assert.equal(binding.destinationPaymentMethodId, EXPECTED.walletPm);
  assert.equal(binding.walletId, EXPECTED.walletId);
  assert.equal(binding.amountCents, SANDBOX_FUNDING_AMOUNT_CENTS);
  assert.equal(binding.browserAuthoritative, false);
  assert.equal(binding.liveFundingPmAuthoritative, true);
  assert.equal(binding.rdsSourceMethodId, rds.banks[0].id);
  assert.notEqual(binding.rdsSourceMethodId, EXPECTED.bankId);
  assert.equal(binding.idempotencyKey.includes(EXPECTED.tenantId), true);
  assert.equal(binding.idempotencyKey.includes('sandbox'), true);
  assert.equal(binding.idempotencyKey.includes('wallet_funding'), true);
  assert.equal(binding.idempotencyKey.includes('cents:1'), true);
  assert.match(sandboxWalletFundingProviderIdempotency(binding.idempotencyKey), /^[0-9a-f-]{36}$/i);
});

test('sandbox writer refuses production IDs, production credentials, and wrong amounts', () => {
  const prodHint = bindingOf({
    clientHints: { bankId: KNOWN_APPROVED_MOOV.freedom.bankId },
  });
  assert.equal(prodHint.ok, false);
  assert.equal(prodHint.error, 'production_ids_blocked');

  const mismatch = bindingOf({
    clientHints: { walletId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'browser_not_authoritative');

  const amount = bindingOf({ amountCents: 2 });
  assert.equal(amount.ok, false);
  assert.equal(amount.error, 'amount_not_one_cent');

  const creds = executeSandboxWalletFunding({
    credentials: { environment: 'production', publicKey: 'p', secretKey: 's' },
    binding: bindingOf(),
    transferPostEnabled: true,
  });
  return creds.then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.error, 'production_credentials_refused');
    assert.equal(result.liveProviderCalled, false);
  });
});

test('durable sandbox wallet_funding intent reuses one idempotency key', async () => {
  const binding = bindingOf();
  const planned = planSandboxWalletFunding(binding);
  const store = createMemoryPayoutStore();
  const first = await persistSandboxFundingIntent(store, planned);
  const second = await persistSandboxFundingIntent(store, planned);
  assert.equal(first.created, true);
  assert.equal(second.reused, true);
  assert.equal(store.inserts.filter((kind) => kind === 'wallet_funding').length, 1);
  assert.equal(first.intent.amount_cents, 1);
  assert.equal(first.intent.environment, 'sandbox');
  assert.equal(first.intent.leg_role, 'wallet_funding');
  assert.equal(
    sandboxWalletFundingIdempotencyKey({
      tenantId: EXPECTED.tenantId,
      environment: 'sandbox',
      operation: 'sandbox_bank_to_wallet',
      leg: 'wallet_funding',
      amountCents: 1,
    }),
    planned.idempotency_key,
  );
});

test('dark sandbox funding holds POST when Lambda sandbox flag is false', async () => {
  const binding = bindingOf();
  let called = 0;
  const result = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    productionPublicKey: 'prod-public',
    productionSecretKey: 'prod-secret',
    binding,
    intent: planSandboxWalletFunding(binding),
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
  assert.equal(called, 0);
});

test('armed sandbox funding POSTs once with UUID idempotency and does not retry unknown', async () => {
  const binding = bindingOf();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = String(url);
    if (path.includes('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sandbox-token' }) };
    }
    calls.push({
      path,
      method: opts.method,
      idempotency: opts.headers?.['X-Idempotency-Key'],
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        transferID: '11111111-2222-4333-8444-555555555555',
        status: 'pending',
        amount: { currency: 'USD', value: 1 },
      }),
    };
  };
  const posted = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    productionPublicKey: 'prod-public',
    binding,
    intent: planSandboxWalletFunding(binding),
    transferPostEnabled: true,
    productionTransferPostEnabled: false,
    fetchImpl,
  });
  assert.equal(posted.outcome, 'posted');
  assert.equal(posted.liveProviderPosted, true);
  assert.equal(posted.provider_transfer_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].path, new RegExp(`/accounts/${EXPECTED.accountId}/transfers`));
  assert.match(calls[0].idempotency, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[0].body.source.paymentMethodID, EXPECTED.achDebitFundPm);
  assert.equal(calls[0].body.destination.paymentMethodID, EXPECTED.walletPm);
  assert.equal(calls[0].body.amount.value, 1);

  const unknownFetch = async (url, opts = {}) => {
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'sandbox-token' }) };
    }
    calls.push({ path: String(url), method: opts.method });
    const error = new Error('fetch failed');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const unknown = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    binding,
    intent: planSandboxWalletFunding(binding),
    transferPostEnabled: true,
    fetchImpl: unknownFetch,
  });
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.doNotRetry, true);
  assert.equal(unknown.liveProviderPosted, false);
  const blocked = await executeSandboxWalletFunding({
    credentials: sandboxCreds,
    binding,
    intent: {
      ...planSandboxWalletFunding(binding),
      provider_metadata: { post_attempted: true },
    },
    transferPostEnabled: true,
    fetchImpl: async () => {
      throw new Error('retry_forbidden');
    },
  });
  assert.equal(blocked.outcome, 'unknown_no_retry');
  assert.equal(blocked.liveProviderCalled, false);
  assert.equal(blocked.doNotRetry, true);
});

test('M7.9E runner arms sandbox only, posts once, and immediately disarms without production POST or wallet→recipient', () => {
  const src = sourceOf('../providers/oneshot/m79e-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  const writer = sourceOf('../functions/api/providers/production/moov-sandbox-wallet-fund.mjs');
  assert.match(src, new RegExp(EXPECTED.tenantId));
  assert.match(src, new RegExp(EXPECTED.accountId));
  assert.match(src, new RegExp(EXPECTED.bankId));
  assert.match(src, new RegExp(EXPECTED.achDebitFundPm));
  assert.match(src, new RegExp(EXPECTED.walletId));
  assert.match(src, /setSandboxPostFlag\('true'\)/);
  assert.match(src, /setSandboxPostFlag\('false'\)/);
  assert.match(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED = value/);
  assert.match(src, /finally/);
  assert.match(src, /setSandboxPostFlag\('false'\)/);
  assert.match(src, /STOP_FOR_REVIEW/);
  assert.match(src, /do not retry|Do not retry|doNotRetry/i);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
  assert.match(oneshot, /persist_funding_intent/);
  assert.match(oneshot, /update_funding_intent/);
  assert.match(oneshot, /verify_funding_intent/);
  assert.match(oneshot, /refused_production_tenant/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
  assert.match(writer, /transfer_post_held/);
  assert.match(writer, /browser_not_authoritative/);
  assert.match(writer, /production_credentials_refused/);
});
