/**
 * Environment-aware operating wallet selection.
 * Fixtures only. No provider or database writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PaymentWalletSelectionError,
  resolveWalletOpsEnvironment,
  selectPaymentWallet,
} from '../../src/lib/payments/selectPaymentWallet.ts';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PROD_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';
const SANDBOX_PM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sandbox = {
  id: 'sandbox-wallet',
  tenant_id: FREEDOM,
  wallet_type: 'operating',
  environment: 'sandbox',
  provider_payment_method_id: SANDBOX_PM,
};
const production = {
  id: 'production-wallet',
  tenant_id: FREEDOM,
  wallet_type: 'operating',
  environment: 'production',
  provider_payment_method_id: PROD_PM,
};

test('1 production request selects the production operating wallet', () => {
  const row = selectPaymentWallet([sandbox, production], {
    tenantId: FREEDOM,
    environment: 'production',
  });
  assert.equal(row?.id, 'production-wallet');
  assert.equal(row?.provider_payment_method_id, PROD_PM);
});

test('2 staging/sandbox request does not select the production wallet', () => {
  const row = selectPaymentWallet([sandbox, production], {
    tenantId: FREEDOM,
    environment: 'sandbox',
  });
  assert.equal(row?.id, 'sandbox-wallet');
  assert.notEqual(row?.provider_payment_method_id, PROD_PM);
});

test('3 duplicate-environment wallet ambiguity fails safely', () => {
  assert.throws(
    () => selectPaymentWallet([production, { ...production, id: 'production-wallet-2' }], {
      tenantId: FREEDOM,
      environment: 'production',
    }),
    (error) => error instanceof PaymentWalletSelectionError && error.code === 'ambiguous_wallet',
  );
});

test('4 missing environment does not silently pick rows[0]', () => {
  assert.throws(
    () => selectPaymentWallet([sandbox, production], { tenantId: FREEDOM, environment: null }),
    (error) => error instanceof PaymentWalletSelectionError && error.code === 'environment_required',
  );
});

test('5 production host resolves to production even if tenant flag is sandbox', () => {
  assert.equal(resolveWalletOpsEnvironment({
    hostname: 'checksops.com',
    tenantMoovEnvironment: 'sandbox',
  }), 'production');
});

test('6 staging host resolves to sandbox even if tenant flag is production', () => {
  assert.equal(resolveWalletOpsEnvironment({
    hostname: 'staging.checksops.com',
    tenantMoovEnvironment: 'production',
    appUrl: 'https://staging.checksops.com',
  }), 'sandbox');
});

test('7 other-tenant wallets are ignored', () => {
  const row = selectPaymentWallet([
    { ...production, tenant_id: OTHER, id: 'other-prod' },
    production,
  ], {
    tenantId: FREEDOM,
    environment: 'production',
  });
  assert.equal(row?.id, 'production-wallet');
});

test('8 no matching environment returns null instead of fabricating a wallet', () => {
  const row = selectPaymentWallet([sandbox], {
    tenantId: FREEDOM,
    environment: 'production',
  });
  assert.equal(row, null);
});
