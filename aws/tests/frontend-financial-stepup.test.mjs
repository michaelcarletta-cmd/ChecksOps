import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awsStepUpBody,
  buildFinancialStepUpRequest,
  cacheAllowsReuse,
  changingCheckRequiresNewAuth,
  isCheckBoundAction,
  isTenantBoundAction,
  stepUpCacheKey,
} from '../../src/lib/financialStepUp.ts';
import { stepUpMatchesCheck } from '../functions/api/providers/production/checkalt-authz.mjs';

const USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const CHECK_A = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';
const CHECK_B = '623442f0-a408-4db5-85be-14bae231a722';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';

test('deposit.submit requires a check id and passes that check through', () => {
  const missing = buildFinancialStepUpRequest({ actionKey: 'deposit.submit' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'check_intake_item_id is required');

  const empty = buildFinancialStepUpRequest({ actionKey: 'deposit.submit', checkId: '   ' });
  assert.equal(empty.ok, false);

  const ok = buildFinancialStepUpRequest({
    actionKey: 'deposit.submit',
    checkId: CHECK_A,
    tenantId: TENANT_B,
    amount: 1.23,
    amount_cents: 123,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.checkId, CHECK_A);
  assert.equal(ok.request.actionKey, 'deposit.submit');
  assert.equal(awsStepUpBody(ok.request).check_intake_item_id, CHECK_A);
  assert.equal(ok.ignored.browserAmount, true);
  assert.equal(ok.ignored.browserAmountCents, true);
  assert.equal(ok.ignored.browserTenantNotAuthoritative, true);
});

test('missing check fails closed and non-deposit actions stay unbound', () => {
  assert.equal(isCheckBoundAction('deposit.submit'), true);
  assert.equal(isCheckBoundAction('deposit.approve'), true);
  assert.equal(isCheckBoundAction('checkalt.auto_deposit.configure'), false);
  assert.equal(isCheckBoundAction('disbursement.send'), false);
  const payroll = buildFinancialStepUpRequest({ actionKey: 'payroll.run' });
  assert.equal(payroll.ok, true);
  assert.equal(payroll.request.checkId, null);
  assert.equal(isTenantBoundAction('checkalt.auto_deposit.configure'), true);
  const configure = buildFinancialStepUpRequest({
    actionKey: 'checkalt.auto_deposit.configure',
    tenantId: TENANT_A,
  });
  assert.equal(configure.ok, true);
  assert.equal(stepUpCacheKey(USER, 'checkalt.auto_deposit.configure', null, TENANT_A)
    !== stepUpCacheKey(USER, 'deposit.submit', CHECK_A), true);
});

test('changing check requires new authorization; stale cache cannot authorize another check', () => {
  const keyA = stepUpCacheKey(USER, 'deposit.submit', CHECK_A);
  const keyB = stepUpCacheKey(USER, 'deposit.submit', CHECK_B);
  assert.equal(changingCheckRequiresNewAuth(CHECK_A, CHECK_B), true);
  assert.equal(changingCheckRequiresNewAuth(CHECK_A, CHECK_A), false);
  assert.equal(cacheAllowsReuse(keyA, keyA), true);
  assert.equal(cacheAllowsReuse(keyA, keyB), false);
  assert.equal(cacheAllowsReuse(stepUpCacheKey(USER, 'deposit.submit', null), keyA), false);
  assert.equal(cacheAllowsReuse(`${USER}|unbound|session`, keyA), false);
});

test('browser amount cannot alter authorization amount', () => {
  const built = buildFinancialStepUpRequest({
    actionKey: 'deposit.submit',
    checkId: CHECK_A,
    amount: 9999.99,
    amount_cents: 1,
  });
  assert.equal(built.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(built.request, 'amount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(awsStepUpBody(built.request), 'amount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(awsStepUpBody(built.request), 'amount_cents'), false);
  assert.equal(stepUpMatchesCheck({
    tenant_id: TENANT_A,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK_A, amount_cents: 500 },
  }, {
    tenantId: TENANT_A,
    checkId: CHECK_A,
    amountCents: 999999,
    actionKey: 'deposit.submit',
  }), false);
});

test('browser tenant cannot alter authorization tenant', () => {
  const built = buildFinancialStepUpRequest({
    actionKey: 'deposit.submit',
    checkId: CHECK_A,
    tenantId: TENANT_B,
  });
  assert.equal(built.ok, true);
  assert.equal(built.ignored.browserTenantNotAuthoritative, true);
  assert.equal(stepUpMatchesCheck({
    tenant_id: TENANT_A,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK_A, amount_cents: 500 },
  }, {
    tenantId: TENANT_B,
    checkId: CHECK_A,
    amountCents: 500,
    actionKey: 'deposit.submit',
  }), false);
});
