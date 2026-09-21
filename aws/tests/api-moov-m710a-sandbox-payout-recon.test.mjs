import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractTransferEvent, normalizeMoovStatus } from '../functions/api/providers/moov-lifecycle.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { SANDBOX_PAYOUT_AMOUNT_CENTS } from '../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const PAYOUT_INTENT = '80f4648b-551c-4ec6-a9fc-921b85bc8320';
const PAYOUT_TRANSFER = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const FUNDING_INTENT = 'b18a96d7-4415-4df8-992f-70d5a17365a9';
const FUNDING_TRANSFER = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const DEST_PM = '7a5ef572-501e-4eac-8c1b-7a4794296a85';
const COMPLETED_ON = '2026-09-21T16:00:00.000000Z';
const ORIGINATED_ON = '2026-09-21T12:00:00.000000Z';

test('destination ACH completedOn and originatedOn are used for WALLET→RECIPIENT payouts', () => {
  const extracted = extractTransferEvent({
    type: 'transfer.updated',
    data: {
      transferID: PAYOUT_TRANSFER,
      status: 'completed',
      amount: { currency: 'USD', valueDecimal: '0.01' },
      source: { paymentMethodID: PIPELINE_TEST_SANDBOX.walletPm, paymentMethodType: 'moov-wallet' },
      destination: {
        paymentMethodID: DEST_PM,
        paymentMethodType: 'ach-credit-standard',
        achDetails: { completedOn: COMPLETED_ON, originatedOn: ORIGINATED_ON, status: 'completed' },
      },
    },
  });
  assert.equal(extracted.transferId, PAYOUT_TRANSFER);
  assert.equal(extracted.status, 'completed');
  assert.equal(extracted.completedOn, COMPLETED_ON);
  assert.equal(extracted.amountCents, SANDBOX_PAYOUT_AMOUNT_CENTS);
  assert.equal(normalizeMoovStatus('pending'), 'pending');
  assert.equal(normalizeMoovStatus('failed'), 'failed');
});

test('M7.10A runner is GET-only for the existing payout and never posts or arms flags', () => {
  const src = sourceOf('../providers/oneshot/m710a-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, new RegExp(PIPELINE));
  assert.match(src, new RegExp(PAYOUT_INTENT));
  assert.match(src, new RegExp(PAYOUT_TRANSFER));
  assert.match(src, new RegExp(DEST_PM));
  assert.match(src, new RegExp(PIPELINE_TEST_SANDBOX.walletPm));
  assert.match(src, new RegExp(PIPELINE_TEST_SANDBOX.walletId));
  assert.match(src, new RegExp(PIPELINE_TEST_SANDBOX.recipientBankId));
  assert.match(src, /assertGetOnly/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /refused_sandbox_post_armed/);
  assert.match(src, /refused_production_post_armed/);
  assert.match(src, /reconcile_payout_parity/);
  assert.match(src, /verify_payout_intent/);
  assert.match(src, /webhook_receipts/);
  assert.match(src, /pendingStop/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.match(src, /Do not POST anything/);
  assert.match(src, /PAYOUT FULLY RECONCILED/);
  assert.match(src, /SANDBOX BANK→WALLET→RECIPIENT LOOP PROVEN/);
  assert.match(src, /destination\?\.achDetails\?\.completedOn/);
  assert.match(src, /destination\?\.achDetails\?\.originatedOn/);
  assert.match(src, new RegExp(FUNDING_INTENT));
  assert.match(src, new RegExp(FUNDING_TRANSFER));
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /persist_payout_intent/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /executeSandboxWalletDisbursement/);
  assert.doesNotMatch(src, /ensureSandboxRecipientAchCredit/);
  assert.doesNotMatch(src, /overlayApi/);
  assert.doesNotMatch(src, /apply_sql78/);
  assert.doesNotMatch(src, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.match(oneshot, /reconcilePayoutParity/);
  assert.match(oneshot, /reconcile_payout_parity/);
  assert.match(oneshot, /funding_intent_refused/);
  assert.match(oneshot, /funding_transfer_refused/);
  assert.match(oneshot, /payout_intent_mismatch/);
  assert.match(oneshot, new RegExp(PAYOUT_INTENT));
  assert.match(oneshot, new RegExp(PAYOUT_TRANSFER));
  assert.match(oneshot, /wallet_disbursement/);
  assert.match(oneshot, /skipped: 'pending'/);
  assert.match(oneshot, /mode: 'update_existing_only'/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_TRANSFER_POST_ENABLED/);
});

test('oneshot payout recon refuses funding IDs and pending writes', () => {
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, new RegExp(`FUNDING_INTENT_ID = '${FUNDING_INTENT}'`));
  assert.match(oneshot, new RegExp(`FUNDING_TRANSFER_ID = '${FUNDING_TRANSFER}'`));
  const fundingBlock = oneshot.slice(
    oneshot.indexOf('const reconcilePayoutParity'),
    oneshot.indexOf('const createDedicatedTenant'),
  );
  assert.match(fundingBlock, /FUNDING_INTENT_ID/);
  assert.match(fundingBlock, /FUNDING_TRANSFER_ID/);
  assert.match(fundingBlock, /intent_leg_mismatch/);
  assert.match(fundingBlock, /request\.moov_get_reconcile/);
  assert.match(fundingBlock, /aws_moov_reconcile_existing_transfer/);
  assert.match(fundingBlock, /aws_moov_reconcile_wallet_cache/);
  assert.match(fundingBlock, /updatePayoutIntent/);
  assert.match(fundingBlock, /snapshotFundingIntent/);
  assert.doesNotMatch(fundingBlock, /persistPayoutIntent/);
  assert.doesNotMatch(fundingBlock, /persistFundingIntent/);
  assert.doesNotMatch(fundingBlock, /INSERT INTO public\.payment_transfers/i);
});
