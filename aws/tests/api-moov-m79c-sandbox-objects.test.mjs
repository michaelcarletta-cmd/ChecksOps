import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { verifyMoovWebhookEnvironment } from '../functions/api/providers/webhooks.mjs';
import { assertNoCrossEnvironmentObject } from '../functions/api/providers/moov-environment.mjs';
import {
  orchestratePayout,
  payoutOperationIdFor,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('M7.9C runner never arms POST, never posts transfers, never creates a replacement webhook by default', () => {
  const src = sourceOf('../providers/oneshot/m79c-run.mjs');
  assert.match(src, /3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43/);
  assert.match(src, /https:\/\/checksops.com\/prep\/webhooks\/moov/);
  assert.match(src, /322271627/);
  assert.match(src, /0001/);
  assert.match(src, /webhook_url_update_not_allowed/);
  assert.match(src, /unused_production_row_refused|unusedProductionReused/);
  assert.match(src, /STOP_FOR_REVIEW/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /console\.log\(.*MOOV_SANDBOX_SECRET_KEY\)/);
  assert.match(src, /termsOfService/);
  assert.match(src, /sandbox-only/);
  assert.doesNotMatch(src, /path: '\/webhooks',\s*[\s\S]{0,40}method: 'POST'/);
});

test('M7.9C oneshot refuses Freedom, production IDs, and unused production rows', () => {
  const src = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
  assert.match(src, /refused_production_tenant/);
  assert.match(src, /production_object_refused/);
  assert.match(src, /unused_production_row_refused/);
  assert.match(src, /object_proof/);
  assert.match(src, /webhook_receipts/);
  assert.match(src, /ChecksOps Pipeline Test/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED/);
});

test('sandbox object guard denies known production IDs and production denies sandbox IDs', () => {
  const sandbox = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId: '60922058-7eca-4889-81dd-5720d7b9de96',
  });
  const production = assertNoCrossEnvironmentObject({
    environment: 'production',
    accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });
  const sandboxOk = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });
  assert.equal(sandbox.ok, false);
  assert.equal(sandbox.error, 'cross_environment_object_refused');
  assert.equal(production.ok, false);
  assert.equal(production.error, 'cross_environment_object_refused');
  assert.equal(sandboxOk.ok, true);
});

test('dark M7.7 against sandbox environment stays unposted for ready/short/pending/failed', async () => {
  const tenantId = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
  const recipientId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const op = payoutOperationIdFor({
    tenantId,
    environment: 'sandbox',
    recipientId,
    payoutCents: 1,
  });
  const labels = {
    fund: { sourceLabel: 'Sandbox bank', destinationLabel: 'Sandbox wallet' },
    disburse: {
      sourceLabel: 'Sandbox wallet',
      destinationLabel: 'Sandbox recipient bank',
      recipientLabel: 'Pipeline Test Payee',
      recipientId,
    },
  };
  const common = {
    payoutCents: 1,
    recipientVerified: true,
    transferPostEnabled: false,
    persistMoneyIntents: false,
    environment: 'sandbox',
    tenantId,
    labels,
  };
  const ready = await orchestratePayout({ ...common, availableCents: 1 });
  const short = await orchestratePayout({ ...common, availableCents: 0 });
  const pending = await orchestratePayout({
    ...common,
    availableCents: 0,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      status: 'submitted',
      origin: 'checksops',
    }],
  });
  const completed = await orchestratePayout({
    ...common,
    availableCents: 1,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      status: 'completed',
      origin: 'checksops',
    }],
  });
  const failed = await orchestratePayout({
    ...common,
    availableCents: 0,
    existingRows: [{
      environment: 'sandbox',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      status: 'failed',
      origin: 'checksops',
    }],
  });
  assert.equal(ready.decision, 'PAYOUT_READY');
  assert.equal(short.decision, 'FUND_FIRST');
  assert.equal(short.shortfall_cents, 1);
  assert.ok(pending.blocked_reasons.includes('funding_pending'));
  assert.equal(completed.payout_state, 'payout_ready');
  assert.ok(failed.blocked_reasons.includes('funding_failed'));
  for (const plan of [ready, short, pending, completed, failed]) {
    assert.equal(plan.environment, 'sandbox');
    assert.equal(plan.live_provider_posted, false);
    assert.equal(plan.persist_money_intents, false);
    assert.equal(plan.transfer_post_enabled, false);
    assert.equal(plan.created_payment_transfer, false);
  }
});

test('webhook dual-secret classification still ignores payload account id', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sandboxSecret = 'sandbox-webhook-secret';
  const productionSecret = 'production-webhook-secret';
  const secrets = {
    MOOV_WEBHOOK_SECRET: productionSecret,
    MOOV_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
  };
  const event = (id, secret) => ({
    headers: {
      'x-timestamp': ts,
      'x-nonce': 'nonce',
      'x-webhook-id': id,
      'x-signature': hmacHex(secret, `${ts}|nonce|${id}`, 'sha512'),
    },
  });
  const sandbox = verifyMoovWebhookEnvironment({
    event: event('evt-s', sandboxSecret),
    rawBody: JSON.stringify({ eventID: 'evt-s', accountID: '60922058-7eca-4889-81dd-5720d7b9de96' }),
    secrets,
  });
  const production = verifyMoovWebhookEnvironment({
    event: event('evt-p', productionSecret),
    rawBody: JSON.stringify({ eventID: 'evt-p', accountID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
    secrets,
  });
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(production.environment, 'production');
});
