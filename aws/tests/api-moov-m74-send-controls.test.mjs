import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  productionMoovTransferPostAllowed,
  PRODUCTION_MOOV_FUNCTIONS,
} from '../functions/api/providers/production/moov-holds.mjs';
import { hasProductionMoovHandler } from '../functions/api/providers/production/moov-dispatch.mjs';
import {
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
  isMoovWalletTotpAction,
} from '../functions/api/providers/production/moov-authz.mjs';
import { CHECKALT_TOTP_ACTION } from '../functions/api/providers/production/checkalt-authz.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('M7.4 prepare production Moov send controls', { concurrency: 1 }, () => {
  test('wallet.fund and wallet.disburse are distinct TOTP actions from deposit.submit', () => {
    assert.equal(MOOV_FUND_TOTP_ACTION, 'wallet.fund');
    assert.equal(MOOV_DISBURSE_TOTP_ACTION, 'wallet.disburse');
    assert.equal(CHECKALT_TOTP_ACTION, 'deposit.submit');
    assert.equal(isMoovWalletTotpAction('wallet.fund'), true);
    assert.equal(isMoovWalletTotpAction('wallet.disburse'), true);
    assert.equal(isMoovWalletTotpAction('deposit.submit'), false);
    const totp = read('aws/functions/api/auth-financial-totp.mjs');
    assert.match(totp, /isMoovWalletTotpAction/);
    assert.match(totp, /resolveMoovWalletStepUpBinding/);
    assert.doesNotMatch(totp, /actionKey !== CHECKALT_TOTP_ACTION && actionKey !== 'wallet/);
  });

  test('live git dispatcher uses hardened M72 writers, not parity money', () => {
    const dispatch = read('aws/functions/api/providers/production/moov-dispatch.mjs');
    assert.match(dispatch, /handleProductionMoovWalletFund/);
    assert.match(dispatch, /handleProductionMoovWalletDisburse/);
    assert.doesNotMatch(dispatch, /from '\.\.\/parity\/moov-money\.mjs'/);
    assert.equal(hasProductionMoovHandler('moov-wallet-fund'), true);
    assert.equal(hasProductionMoovHandler('moov-disburse'), true);
    assert.equal(PRODUCTION_MOOV_FUNCTIONS.has('moov-transfer-create'), false);
    assert.equal(PRODUCTION_MOOV_FUNCTIONS.has('calculate-payment-funding'), false);
  });

  test('first-test cap is 1 cent and transfer POST defaults off', async () => {
    assert.equal(FIRST_PRODUCTION_TRANSFER_CENTS, 1);
    await withEnv({
      AWS_PROVIDER_EXECUTION_ENABLED: 'true',
      AWS_MOOV_ENABLED: 'true',
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
      AWS_MOOV_TRANSFER_POST_ENABLED: undefined,
    }, () => {
      assert.equal(productionMoovTransferPostAllowed(), false);
    });
    const templates = [
      read('aws/template.yaml'),
      read('aws/production/api-template.yaml'),
      read('aws/production/api-cfn.yaml'),
    ];
    for (const yaml of templates) {
      assert.match(yaml, /AWS_MOOV_TRANSFER_POST_ENABLED: "false"/);
      assert.match(yaml, /AWS_MOOV_ENABLED: "false"/);
      assert.match(yaml, /AWS_CHECKALT_ENABLED: "false"/);
    }
  });

  test('SPA money path no longer originates moov-transfer-create', () => {
    const provider = read('src/lib/payments/providers/moovProvider.ts');
    const wallets = read('src/lib/payments/wallets.ts');
    const panel = read('src/components/payments/WalletPanel.tsx');
    const consoleSource = read('src/components/disbursement/DisbursementConsole.tsx');
    assert.match(provider, /FIRST_TEST_DISBURSE_FN/);
    assert.doesNotMatch(provider, /moov-transfer-create/);
    assert.match(wallets, /FIRST_TEST_FUND_FN/);
    assert.match(wallets, /FIRST_TEST_DISBURSE_FN/);
    assert.match(panel, /FIRST_TEST_FUND_TOTP/);
    assert.match(panel, /FIRST_TEST_DISBURSE_TOTP/);
    assert.doesNotMatch(consoleSource, /invoke\(\s*"initiate-wallet-funding"/);
    assert.match(consoleSource, /wallet\.disburse/);
  });

  test('writers bind server-authoritative Freedom parties and hold POST when dark', () => {
    const fund = read('aws/functions/api/providers/production/moov-wallet-fund.mjs');
    const disburse = read('aws/functions/api/providers/production/moov-wallet-disburse.mjs');
    assert.match(fund, /firstTestFundBinding/);
    assert.match(fund, /transfer_post_held/);
    assert.match(fund, /approved_payment_method_mismatch/);
    assert.match(disburse, /firstTestDisburseBinding/);
    assert.match(disburse, /transfer_post_held/);
    assert.match(disburse, /productionMoovTransferPostAllowed/);
  });

  test('legacy combined money names stay blocked when production flags are on', async () => {
    const denied = await withEnv({
      AWS_PROVIDER_EXECUTION_ENABLED: 'true',
      AWS_MOOV_ENABLED: 'true',
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    }, () => handleProviderRequest(
      {
        rawPath: '/functions/v1/moov-transfer-create',
        headers: { authorization: 'Bearer test-id-token' },
        body: JSON.stringify({ amount_cents: 1 }),
        requestContext: {
          http: { method: 'POST', path: '/functions/v1/moov-transfer-create' },
          authorizer: { jwt: { claims: { sub: 'c4386408-60e1-70e2-abb6-e6194e8e635f', token_use: 'id' } } },
        },
      },
      '/functions/v1/moov-transfer-create',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost' }),
        createClient: () => ({
          connect: async () => {},
          end: async () => {},
          query: async () => ({ rows: [] }),
        }),
      },
    ));
    assert.equal(denied.error, 'production_execution_blocked');
  });

  test('TOTP is required before any Moov HTTP on fund and disburse', () => {
    const fund = read('aws/functions/api/providers/production/moov-wallet-fund.mjs');
    const disburse = read('aws/functions/api/providers/production/moov-wallet-disburse.mjs');
    const fundAuthz = fund.indexOf('authorizeMoovProduction');
    const fundFetch = fund.indexOf('productionMoovFetch');
    const disburseAuthz = disburse.indexOf('authorizeMoovProduction');
    const disburseFetch = disburse.indexOf('productionMoovFetch');
    assert.ok(fundAuthz > 0 && fundAuthz < fundFetch);
    assert.ok(disburseAuthz > 0 && disburseAuthz < disburseFetch);
    assert.doesNotMatch(fund, /checkalt-submit|plaid/i);
    assert.doesNotMatch(disburse, /from '\.\.\/parity\/moov-money/);
  });

  test('wallet TOTP never reuses CheckAlt session TOTP', () => {
    const totp = read('aws/functions/api/auth-financial-totp.mjs');
    assert.match(totp, /walletAction/);
    assert.match(totp, /isFinancialSessionTotpAction/);
    assert.match(totp, /wallet\.fund \/ wallet\.disburse never reuse/);
  });

  test('legacy Supabase money writers fail closed without Moov HTTP', () => {
    const names = [
      'moov-transfer-create',
      'moov-disburse',
      'moov-wallet-fund',
      'initiate-wallet-funding',
      'process-funded-payment',
      'wallet-fund-on-clear',
      'moov-transfer-group-create',
      'cancel-wallet-funding',
    ];
    for (const name of names) {
      const source = read(`supabase/functions/${name}/index.ts`);
      assert.match(source, /legacyMoovMoneyShutdownResponse/);
      assert.doesNotMatch(source, /moovFetch/);
      assert.doesNotMatch(source, /\/transfers/);
    }
    const webhook = read('supabase/functions/moov-webhook/index.ts');
    assert.match(webhook, /process-funded-payment/);
    assert.doesNotMatch(webhook, /legacyMoovMoneyShutdownResponse/);
  });
});
