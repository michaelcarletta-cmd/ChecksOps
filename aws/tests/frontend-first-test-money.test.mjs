import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  CHECKALT_DEPOSIT_TOTP,
  COUPLED_FUNDING_FN,
  FIRST_TEST_CAP_MESSAGE,
  FIRST_TEST_DISBURSE_FN,
  FIRST_TEST_DISBURSE_TOTP,
  FIRST_TEST_FUND_FN,
  FIRST_TEST_FUND_TOTP,
  FIRST_TEST_TRANSFER_CENTS,
  FIRST_TEST_TRANSFER_DOLLARS,
  LEGACY_COMBINED_TRANSFER_FN,
  assertFirstTestAmountCents,
  firstTestDisburseBody,
  firstTestFundBody,
  isFirstTestAmountCents,
  isTransferPostHeld,
  parseFirstTestAmountCents,
} from '../../src/lib/payments/firstTestMoney.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('M7.5 live SPA first-test money routing', () => {
  test('UI and client cap is exactly 1 cent', () => {
    assert.equal(FIRST_TEST_TRANSFER_CENTS, 1);
    assert.equal(FIRST_TEST_TRANSFER_DOLLARS, '0.01');
    assert.equal(isFirstTestAmountCents(1), true);
    assert.equal(isFirstTestAmountCents(2), false);
    assert.equal(parseFirstTestAmountCents('0.01'), 1);
    assert.equal(parseFirstTestAmountCents('1.00'), null);
    assert.equal(parseFirstTestAmountCents('0.02'), null);
    assert.throws(() => assertFirstTestAmountCents(100), /capped at \$0\.01/);
    assert.equal(assertFirstTestAmountCents(1), 1);
  });

  test('browser bodies omit bank, wallet, recipient, and Moov account IDs', () => {
    const fund = firstTestFundBody({ tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', idempotencyKey: 'k1' });
    const disburse = firstTestDisburseBody({ tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', idempotencyKey: 'k2' });
    for (const body of [fund, disburse]) {
      assert.equal(body.amount_cents, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'bank_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'wallet_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'external_recipient_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'recipient_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'moov_account_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'source_payment_method_id'), false);
    }
    assert.equal(fund.source_kind, 'bank');
    assert.equal(disburse.source_kind, 'wallet');
  });

  test('live money UI uses wallet.fund / wallet.disburse and never moov-transfer-create', () => {
    const panel = read('src/components/payments/WalletPanel.tsx');
    const wallets = read('src/lib/payments/wallets.ts');
    const provider = read('src/lib/payments/providers/moovProvider.ts');
    const auto = read('src/hooks/useAutoFunding.ts');
    const autoPanel = read('src/components/payments/AutoFundingPanel.tsx');
    const payroll = read('src/components/payroll/RunPayrollDialog.tsx');
    const consoleSource = read('src/components/disbursement/DisbursementConsole.tsx');
    const awsClient = read('src/integrations/aws/client.ts');

    assert.match(panel, /FIRST_TEST_FUND_TOTP/);
    assert.match(panel, /FIRST_TEST_DISBURSE_TOTP/);
    assert.match(panel, /Add \{FIRST_TEST_TRANSFER_LABEL\} from bank/);
    assert.match(panel, /Authorize held \{FIRST_TEST_TRANSFER_LABEL\} fund/);
    assert.match(panel, /Send \{FIRST_TEST_TRANSFER_LABEL\} from wallet/);
    const authorizeFn = panel.slice(
      panel.indexOf('async function handleAuthorizeHeldFund'),
      panel.indexOf('async function handleDisburse'),
    );
    assert.match(authorizeFn, /guardFinancial\(FIRST_TEST_FUND_TOTP/);
    assert.doesNotMatch(authorizeFn, /fund\.mutateAsync/);
    assert.doesNotMatch(authorizeFn, /nextFirstTestIdempotencyKey/);
    assert.match(panel, /aria-label="First-test fund amount locked at \$0\.01"/);
    assert.match(autoPanel, /aria-label="First-test fund amount locked at \$0\.01"/);
    assert.match(autoPanel, /isTransferPostHeld/);
    assert.doesNotMatch(panel, /deposit\.submit/);
    assert.doesNotMatch(panel, /moov-transfer-create/);

    assert.match(wallets, /FIRST_TEST_FUND_FN/);
    assert.match(wallets, /FIRST_TEST_DISBURSE_FN/);
    assert.match(wallets, /assertFirstTestAmountCents/);
    assert.doesNotMatch(wallets, /moov-transfer-create/);
    assert.doesNotMatch(wallets, /initiate-wallet-funding/);

    assert.match(provider, /FIRST_TEST_DISBURSE_FN/);
    assert.doesNotMatch(provider, /moov-transfer-create/);
    assert.doesNotMatch(provider, /external_recipient_id/);

    assert.match(auto, /fundWallet/);
    assert.doesNotMatch(auto, /invoke\("initiate-wallet-funding"/);
    assert.match(autoPanel, /FIRST_TEST_FUND_TOTP/);
    assert.match(autoPanel, /FIRST_TEST_TRANSFER_LABEL/);

    assert.doesNotMatch(payroll, /functions\.invoke\("moov-disburse"/);
    assert.match(payroll, /does not originate moov-disburse/);

    assert.doesNotMatch(consoleSource, /moov-transfer-create/);
    assert.doesNotMatch(consoleSource, /invoke\(\s*"initiate-wallet-funding"/);

    assert.match(awsClient, /\/functions\/v1\/\$\{encodeURIComponent\(name\)\}/);
    assert.doesNotMatch(awsClient, /supabase\.co/);
  });

  test('TOTP actions stay distinct from deposit.submit', () => {
    assert.equal(FIRST_TEST_FUND_TOTP, 'wallet.fund');
    assert.equal(FIRST_TEST_DISBURSE_TOTP, 'wallet.disburse');
    assert.equal(CHECKALT_DEPOSIT_TOTP, 'deposit.submit');
    assert.notEqual(FIRST_TEST_FUND_TOTP, CHECKALT_DEPOSIT_TOTP);
    assert.notEqual(FIRST_TEST_DISBURSE_TOTP, CHECKALT_DEPOSIT_TOTP);
    assert.equal(FIRST_TEST_FUND_FN, 'moov-wallet-fund');
    assert.equal(FIRST_TEST_DISBURSE_FN, 'moov-disburse');
    assert.equal(LEGACY_COMBINED_TRANSFER_FN, 'moov-transfer-create');
    assert.equal(COUPLED_FUNDING_FN, 'initiate-wallet-funding');
  });

  test('dark hold is recognized without treating it as a Moov POST', () => {
    assert.equal(isTransferPostHeld(new Error('transfer_post_held')), true);
    assert.equal(isTransferPostHeld(new Error('first_transfer_cap')), false);
    assert.match(FIRST_TEST_CAP_MESSAGE, /\$0\.01/);
  });
});
