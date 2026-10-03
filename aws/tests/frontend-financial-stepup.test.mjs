import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FINANCIAL_STEPUP_CLIENT_CLOCK_SKEW_MS,
  FINANCIAL_STEPUP_TTL_MS,
  awsStepUpBody,
  buildFinancialStepUpRequest,
  cacheAllowsReuse,
  changingCheckRequiresNewAuth,
  isAmbiguousFinancialProviderOutcome,
  isCheckBoundAction,
  isFinancialStepUpRequiredError,
  parseStepUpCacheEntry,
  resolveStepUpAuthorizedAt,
  runFinancialActionWithStepUp,
  stepUpCacheAllowsReuse,
  stepUpCacheKey,
  stepUpCacheRemainingMs,
} from '../../src/lib/financialStepUp.ts';
import { FINANCIAL_STEPUP_TTL_MS as SERVER_FINANCIAL_TTL_MS } from '../functions/api/financial-totp.mjs';
import { TOTP_STEPUP_TTL_MS, stepUpMatchesCheck } from '../functions/api/providers/production/checkalt-authz.mjs';

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
  assert.equal(isCheckBoundAction('disbursement.send'), false);
  const payroll = buildFinancialStepUpRequest({ actionKey: 'payroll.run' });
  assert.equal(payroll.ok, true);
  assert.equal(payroll.request.checkId, null);
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

test('browser cache TTL matches server authorization window and cannot outlive it', () => {
  assert.equal(FINANCIAL_STEPUP_TTL_MS, TOTP_STEPUP_TTL_MS);
  assert.equal(FINANCIAL_STEPUP_TTL_MS, SERVER_FINANCIAL_TTL_MS);
  const now = Date.parse('2026-09-23T09:40:00.000Z');
  const serverAt = now - (5 * 60 * 1000);
  const resolved = resolveStepUpAuthorizedAt({
    serverCreatedAt: new Date(serverAt).toISOString(),
    clientNowMs: now,
  });
  assert.equal(resolved.source, 'server');
  assert.equal(resolved.authorizedAt, serverAt);
  assert.equal(stepUpCacheRemainingMs({ authorizedAt: serverAt, source: 'server' }, now), FINANCIAL_STEPUP_TTL_MS - (5 * 60 * 1000));
  assert.equal(stepUpCacheRemainingMs({
    authorizedAt: now - FINANCIAL_STEPUP_TTL_MS,
    source: 'server',
  }, now), 0);
  assert.ok(stepUpCacheRemainingMs({
    authorizedAt: now,
    source: 'client',
  }, now) <= FINANCIAL_STEPUP_TTL_MS - FINANCIAL_STEPUP_CLIENT_CLOCK_SKEW_MS);
});

test('valid unexpired step-up works; expired or legacy client cache requires fresh TOTP', () => {
  const now = Date.parse('2026-09-23T09:40:00.000Z');
  const approveKey = stepUpCacheKey(USER, 'deposit.approve', CHECK_A);
  const fresh = {
    userId: USER,
    key: approveKey,
    authorizedAt: now - (10 * 60 * 1000),
    source: 'server',
  };
  assert.equal(stepUpCacheAllowsReuse(fresh, approveKey, now), true);
  assert.equal(parseStepUpCacheEntry(fresh, USER, now)?.key, approveKey);

  const expired = {
    userId: USER,
    key: approveKey,
    authorizedAt: now - FINANCIAL_STEPUP_TTL_MS - 1,
    source: 'server',
  };
  assert.equal(stepUpCacheAllowsReuse(expired, approveKey, now), false);
  assert.equal(parseStepUpCacheEntry(expired, USER, now), null);

  const legacyNoTimestamp = { userId: USER, key: approveKey };
  assert.equal(parseStepUpCacheEntry(legacyNoTimestamp, USER, now), null);
  assert.equal(stepUpCacheAllowsReuse({ key: approveKey }, approveKey, now), false);
});

test('deposit.submit authorization cannot satisfy deposit.approve', () => {
  const now = Date.parse('2026-09-23T09:40:00.000Z');
  const submitKey = stepUpCacheKey(USER, 'deposit.submit', CHECK_A);
  const approveKey = stepUpCacheKey(USER, 'deposit.approve', CHECK_A);
  assert.notEqual(submitKey, approveKey);
  assert.equal(stepUpCacheAllowsReuse({
    key: submitKey,
    authorizedAt: now,
    source: 'server',
  }, approveKey, now), false);
  assert.equal(stepUpMatchesCheck({
    tenant_id: TENANT_A,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK_A, amount_cents: 500 },
  }, {
    tenantId: TENANT_A,
    checkId: CHECK_A,
    amountCents: 500,
    actionKey: 'deposit.approve',
  }), false);
});

test('stale client cache plus server step_up_required invalidates and challenges again', async () => {
  const approveKey = stepUpCacheKey(USER, 'deposit.approve', CHECK_A);
  const challenges = [];
  let cacheValid = true;
  const requireStepUp = async (request, options) => {
    challenges.push({ actionKey: request.actionKey, force: options?.force === true });
    if (cacheValid && !options?.force) return true;
    return true;
  };
  let calls = 0;
  const result = await runFinancialActionWithStepUp({
    requireStepUp,
    invalidateStepUp: () => { cacheValid = false; },
    request: { actionKey: 'deposit.approve', checkId: CHECK_A },
    action: async () => {
      calls += 1;
      if (calls === 1) throw new Error('step_up_required');
      return { ok: true, approved: true };
    },
  });
  assert.equal(result.approved, true);
  assert.equal(calls, 2);
  assert.equal(challenges.length, 2);
  assert.equal(challenges[1].force, true);
  assert.equal(cacheValid, false);
  assert.equal(isFinancialStepUpRequiredError(new Error('step_up_required')), true);
  assert.equal(stepUpCacheAllowsReuse({
    key: approveKey,
    authorizedAt: Date.parse('2026-09-23T02:07:08.000Z'),
    source: 'server',
  }, approveKey, Date.parse('2026-09-23T09:38:46.000Z')), false);
});

test('successful fresh deposit.approve step-up allows the action; invalid TOTP never calls approval', async () => {
  const allowed = await runFinancialActionWithStepUp({
    requireStepUp: async () => true,
    request: { actionKey: 'deposit.approve', checkId: CHECK_A },
    action: async () => ({ ok: true, action: 'approve' }),
  });
  assert.equal(allowed.action, 'approve');

  let approveCalls = 0;
  await assert.rejects(
    () => runFinancialActionWithStepUp({
      requireStepUp: async () => false,
      request: { actionKey: 'deposit.approve', checkId: CHECK_A },
      action: async () => {
        approveCalls += 1;
        return { ok: true };
      },
    }),
    { error: 'totp_required' },
  );
  assert.equal(approveCalls, 0);
});

test('ambiguous provider outcomes are never automatically retried', async () => {
  for (const code of ['checkalt_approve_failed', 'provider_timeout', 'reconciliation_required']) {
    let calls = 0;
    let challenged = 0;
    await assert.rejects(
      () => runFinancialActionWithStepUp({
        requireStepUp: async () => {
          challenged += 1;
          return true;
        },
        invalidateStepUp: () => {},
        request: { actionKey: 'deposit.approve', checkId: CHECK_A },
        action: async () => {
          calls += 1;
          throw new Error(code);
        },
      }),
      { message: code },
    );
    assert.equal(calls, 1, code);
    assert.equal(challenged, 1, code);
    assert.equal(isAmbiguousFinancialProviderOutcome(new Error(code)), true);
  }
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
