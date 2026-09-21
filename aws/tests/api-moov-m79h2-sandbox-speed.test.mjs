import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PIPELINE_TEST_SANDBOX,
  awsSandboxFundingRequestFromCode,
  compareLovableVsAwsSandboxFundingRequest,
  lovableSandboxFundingRequestFromCode,
} from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EXPECTED = PIPELINE_TEST_SANDBOX;

test('M7.9H.2 runner GET-only compares old sandbox transfers and never posts or mutates intents', () => {
  const src = sourceOf('../providers/oneshot/m79h2-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /b18a96d7-4415-4df8-992f-70d5a17365a9/);
  assert.match(src, /dec24b01-e559-4014-b072-af1ac0e4d013/);
  assert.match(src, new RegExp(EXPECTED.platformAccountId));
  assert.match(src, new RegExp(EXPECTED.achDebitFundPm));
  assert.match(src, new RegExp(EXPECTED.walletPm));
  assert.match(src, /transfers\/\$\{MOOV_TRANSFER_ID\}/);
  assert.match(src, /transfers\?count=200/);
  assert.match(src, /list_sandbox_history/);
  assert.match(src, /verify_funding_intent/);
  assert.match(src, /webhook_receipts/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.match(src, /compareLovableVsAwsSandboxFundingRequest/);
  assert.match(src, /docs\.moov\.io\/guides\/get-started\/test-mode/);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /update_funding_intent/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.match(oneshot, /listSandboxHistory/);
  assert.match(oneshot, /environment = 'sandbox'/);
  assert.doesNotMatch(oneshot, /\/transfers/);
});

test('Lovable and AWS sandbox funding writers use the same ACH debit→wallet facilitator contract', () => {
  const lovableFund = sourceOf('../../supabase/functions/moov-wallet-fund/index.ts');
  const lovableInitiate = sourceOf('../../supabase/functions/initiate-wallet-funding/index.ts');
  const lovableClient = sourceOf('../../supabase/functions/_shared/moovClient.ts');
  const awsWriter = sourceOf('../functions/api/providers/production/moov-sandbox-wallet-fund.mjs');
  const awsBody = sourceOf('../functions/api/providers/moov-sandbox.mjs');
  assert.match(lovableFund, /\/accounts\/\$\{facilitatorId\}\/transfers/);
  assert.match(lovableFund, /paymentMethodID: sourceMethodId/);
  assert.match(lovableFund, /paymentMethodID: wallet.provider_payment_method_id/);
  assert.match(lovableFund, /resolveDebitSourceMethodId/);
  assert.match(lovableInitiate, /\/accounts\/\$\{facilitatorId\}\/transfers/);
  assert.match(lovableInitiate, /paymentMethodID: sourceMethodId/);
  assert.doesNotMatch(lovableFund, /x-wait-for|rail-response/);
  assert.doesNotMatch(lovableInitiate, /x-wait-for|rail-response/);
  assert.doesNotMatch(lovableClient, /x-wait-for|rail-response/);
  assert.match(lovableClient, /v2024\.01\.00/);
  assert.doesNotMatch(awsWriter, /x-wait-for|rail-response/);
  assert.doesNotMatch(awsBody, /x-wait-for|rail-response/);
  assert.match(awsBody, /source: \{ paymentMethodID: sourcePaymentMethodId \}/);
  assert.match(awsBody, /destination: \{ paymentMethodID: destinationPaymentMethodId \}/);
  const compare = compareLovableVsAwsSandboxFundingRequest();
  assert.equal(compare.sameApiVersion, true);
  assert.equal(compare.sameSourceType, true);
  assert.equal(compare.sameDestinationType, true);
  assert.equal(compare.sameWaitFor, true);
  assert.equal(compare.walletToWalletUsedByEither, false);
  assert.equal(lovableSandboxFundingRequestFromCode.sourcePaymentMethodType, 'ach-debit-fund');
  assert.equal(lovableSandboxFundingRequestFromCode.destinationPaymentMethodType, 'moov-wallet');
  assert.equal(awsSandboxFundingRequestFromCode.xWaitFor, null);
  assert.equal(awsSandboxFundingRequestFromCode.walletToWallet, false);
});
