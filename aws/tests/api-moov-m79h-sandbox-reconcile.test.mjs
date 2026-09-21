import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EXPECTED = PIPELINE_TEST_SANDBOX;

test('M7.9H runner GET-only reconciles the existing transfer and never posts or creates intents', () => {
  const src = sourceOf('../providers/oneshot/m79h-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /b18a96d7-4415-4df8-992f-70d5a17365a9/);
  assert.match(src, /dec24b01-e559-4014-b072-af1ac0e4d013/);
  assert.match(src, new RegExp(EXPECTED.platformAccountId));
  assert.match(src, new RegExp(EXPECTED.achDebitFundPm));
  assert.match(src, new RegExp(EXPECTED.walletPm));
  assert.match(src, new RegExp(EXPECTED.walletId));
  assert.match(src, /transfers\/\$\{MOOV_TRANSFER_ID\}/);
  assert.match(src, /wallets\/\$\{SANDBOX_WALLET\}/);
  assert.match(src, /verify_funding_intent/);
  assert.match(src, /webhook_receipts/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.match(src, /completed_at/);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /wallet-disburse|wallet_disbursement/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.match(oneshot, /COALESCE\(completed_at, \$9::timestamptz\)/);
  assert.match(oneshot, /mapped_internal_id::text = ANY/);
  assert.doesNotMatch(oneshot, /\/transfers/);
});
