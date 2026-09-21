import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleProductionPayoutE2e } from '../functions/api/providers/production/moov-production-payout-e2e.mjs';
import { hasProductionMoovHandler } from '../functions/api/providers/production/moov-dispatch.mjs';
import { refuseIndependentMustKeepInvocation } from '../functions/api/providers/production/moov-production-transfer-primitives.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';
import { CONSUME_TOTP_THIS_PHASE } from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('HTTP e2e handler refuses persist, POST, and TOTP codes', async () => {
  const persist = await handleProductionPayoutE2e({
    client: { query: async () => ({ rows: [] }) },
    mapping: { application_user_id: '00000000-0000-4000-8000-000000000000' },
    body: { persist: true },
  });
  assert.equal(persist.error, 'money_intent_persist_refused');
  assert.equal(persist.createdPaymentTransfer, false);
  const post = await handleProductionPayoutE2e({
    client: { query: async () => ({ rows: [] }) },
    mapping: { application_user_id: '00000000-0000-4000-8000-000000000000' },
    body: { execute: true },
  });
  assert.equal(post.error, 'provider_post_refused');
  const totp = await handleProductionPayoutE2e({
    client: { query: async () => ({ rows: [] }) },
    mapping: { application_user_id: '00000000-0000-4000-8000-000000000000' },
    body: { totp_code: '123456' },
  });
  assert.equal(totp.error, 'totp_code_refused');
});

test('MUST_KEEP writers are intercepted as independent invocations', () => {
  assert.equal(hasProductionMoovHandler('moov-wallet-fund'), true);
  assert.equal(hasProductionMoovHandler('moov-wallet-disburse'), true);
  assert.equal(hasProductionMoovHandler('moov-production-payout-e2e'), true);
  const blocked = refuseIndependentMustKeepInvocation('moov-wallet-fund');
  assert.equal(blocked.error, 'independent_must_keep_writer_blocked');
  assert.equal(FUNCTION_BY_NAME['moov-production-payout-e2e'].aws, 'dark_deployed');
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  assert.equal(evaluateFinancialAuthorization({
    operation: 'wallet_fund',
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    permissionsActivated: true,
  }).canExecuteProduction, false);
});

test('M7.15 overlay does not replace MUST_KEEP writers or arm POST', () => {
  const src = sourceOf('../providers/oneshot/m715-prod-e2e-deploy-run.mjs');
  assert.match(src, /MUST_KEEP/);
  assert.match(src, /moov-production-payout-e2e\.mjs/);
  assert.match(src, /overlay mutated protected file/);
  assert.match(src, /patchLiveCatalog/);
  assert.match(src, /validateDispatchNotShrinking/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.equal(existsSync(path.join(ROOT, 'functions/api/providers/production/moov-wallet-fund.mjs')), false);
  assert.equal(existsSync(path.join(ROOT, 'functions/api/providers/production/moov-wallet-disburse.mjs')), false);
  const e2e = sourceOf('../functions/api/providers/production/moov-production-payout-e2e.mjs');
  const primitives = sourceOf('../functions/api/providers/production/moov-production-transfer-primitives.mjs');
  assert.doesNotMatch(e2e, /moov-sandbox-wallet-fund/);
  assert.doesNotMatch(primitives, /moov-sandbox-wallet-fund/);
});
