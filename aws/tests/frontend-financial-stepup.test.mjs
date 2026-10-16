import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awsStepUpBody,
  buildFinancialStepUpRequest,
  cacheAllowsReuse,
  isCheckBoundAction,
  isStepUpRequiredError,
  stepUpCacheKey,
} from '../../src/lib/financialStepUp.ts';
import { authorizeCheckAltProduction } from '../functions/api/providers/production/checkalt-authz.mjs';

// What the server consults for a Check Alt step-up, given a browser that sends
// its own tenant and amount: the check's tenant and the login, never the hints.
const stepUpLookup = async ({ checkTenant, amount }) => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('FROM public.tenant_users')) return { rows: [{ role: 'admin' }] };
      return { rows: [] };
    },
  };
  const result = await authorizeCheckAltProduction({
    client,
    mapping: { application_user_id: USER },
    claims: { sub: 'cognito-sub', origin_jti: 'login-1' },
    memberships: [{ tenant_id: checkTenant, role: 'admin' }],
    check: { id: CHECK_A, tenant_id: checkTenant, amount },
  });
  return { result, lookup: queries.find((q) => q.sql.includes('FROM public.financial_stepup_log')) };
};

const USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const CHECK_A = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';
const CHECK_B = '623442f0-a408-4db5-85be-14bae231a722';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_B = '4f172140-f57a-4744-8050-95f4f07b13b4';

test('deposit.approve requires a check id and shares the login\'s Check Alt verification with deposit.submit', () => {
  const missing = buildFinancialStepUpRequest({ actionKey: 'deposit.approve' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'check_intake_item_id is required');
  const ok = buildFinancialStepUpRequest({
    actionKey: 'deposit.approve',
    checkId: CHECK_A,
    amount: 1546.72,
    amount_cents: 1,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.actionKey, 'deposit.approve');
  assert.equal(ok.request.checkId, CHECK_A);
  const body = awsStepUpBody(ok.request);
  assert.equal(body.action_key, 'deposit.approve');
  assert.equal(body.check_intake_item_id, CHECK_A);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'amount_cents'), false);
  const submitKey = stepUpCacheKey(USER, 'deposit.submit', CHECK_A);
  const approveKey = stepUpCacheKey(USER, 'deposit.approve', CHECK_A);
  assert.equal(cacheAllowsReuse(submitKey, approveKey), true);
  assert.equal(cacheAllowsReuse(approveKey, stepUpCacheKey(USER, 'deposit.approve', CHECK_B)), true);
});

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
  assert.equal(isCheckBoundAction('disbursement.send'), false);
  const payroll = buildFinancialStepUpRequest({ actionKey: 'payroll.run' });
  assert.equal(payroll.ok, true);
  assert.equal(payroll.request.checkId, null);
});

test('another check reuses the login\'s Check Alt verification; another user or a Moov session does not', () => {
  const keyA = stepUpCacheKey(USER, 'deposit.submit', CHECK_A);
  const keyB = stepUpCacheKey(USER, 'deposit.submit', CHECK_B);
  assert.equal(keyA, `${USER}|checkalt|session`);
  assert.equal(cacheAllowsReuse(keyA, keyA), true);
  assert.equal(cacheAllowsReuse(keyA, keyB), true);
  assert.equal(cacheAllowsReuse(stepUpCacheKey(USER, 'deposit.submit', null), keyA), false);
  assert.equal(cacheAllowsReuse(keyA, stepUpCacheKey('another-user', 'deposit.submit', CHECK_A)), false);
  assert.equal(cacheAllowsReuse(`${USER}|unbound|session`, keyA), false);
  assert.equal(cacheAllowsReuse(keyA, stepUpCacheKey(USER, 'wallet.fund', null)), false);
  assert.equal(stepUpCacheKey(null, 'deposit.submit', CHECK_A), null);
});

test('only the server step_up_required answer asks for a new code', () => {
  assert.equal(isStepUpRequiredError(new Error('step_up_required')), true);
  assert.equal(isStepUpRequiredError('step_up_required'), true);
  assert.equal(isStepUpRequiredError(new Error('financial_unauthorized')), false);
  assert.equal(isStepUpRequiredError(new Error('cross_tenant_denied')), false);
  assert.equal(isStepUpRequiredError(null), false);
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
});

test('browser amount and tenant are not part of the server step-up lookup', async () => {
  const { result, lookup } = await stepUpLookup({ checkTenant: TENANT_A, amount: 5 });
  assert.equal(result.error, 'step_up_required');
  assert.equal(lookup.params[1], TENANT_A);
  assert.equal(lookup.params[3], 'cognito-sub:jti:login-1');
  assert.equal(lookup.params.includes(500), false);
  assert.equal(lookup.params.includes(999999), false);
  assert.equal(lookup.params.includes(TENANT_B), false);
});

test('browser tenant cannot alter authorization tenant', () => {
  const built = buildFinancialStepUpRequest({
    actionKey: 'deposit.submit',
    checkId: CHECK_A,
    tenantId: TENANT_B,
  });
  assert.equal(built.ok, true);
  assert.equal(built.ignored.browserTenantNotAuthoritative, true);
  assert.equal(awsStepUpBody(built.request).check_intake_item_id, CHECK_A);
});
