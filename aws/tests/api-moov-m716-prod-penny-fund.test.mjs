import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import { CONSUME_TOTP_THIS_PHASE } from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  executeProductionPayoutE2e,
  m714PayoutOperationId,
} from '../functions/api/providers/production/moov-production-payout-e2e.mjs';
import {
  evaluateOneAuthorizedLegPost,
} from '../functions/api/providers/production/moov-production-penny-authz.mjs';
import {
  executeProductionWalletDisbursement,
  executeProductionWalletFunding,
} from '../functions/api/providers/production/moov-production-transfer-primitives.mjs';
import { firstTestFundBinding, MOOV_FUND_TOTP_ACTION } from '../functions/api/providers/production/moov-first-test.mjs';
import {
  WALLET_FUND_AUTHORIZE_ACTION,
  buildWalletFundAuthorizeRequest,
  runWalletFundAuthorization,
} from '../../src/lib/walletFundAuthorize.ts';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom;
const FUND_KEY = `checksops:m77:wallet_funding:env:production:op:${m714PayoutOperationId()}:cents:1`;

const fundBinding = () => ({
  ...firstTestFundBinding(),
  amountCents: 1,
  accountId: FREEDOM.moovAccountId,
  platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
  idempotencyKey: FUND_KEY,
});

test('oneshot persist refuses payout and keeps production funding CAS', () => {
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, /payout_intent_refused_phase_a/);
  assert.match(oneshot, /persist_production_funding_intent/);
  assert.match(oneshot, /cas_mark_production_funding_post_attempt/);
  assert.match(oneshot, /consume_wallet_fund_stepup/);
  assert.match(oneshot, /abandon_m716_penny_intent/);
});

test('wallet.fund authorize UI never funds or disburses', async () => {
  const built = buildWalletFundAuthorizeRequest();
  assert.equal(built.ok, true);
  assert.equal(built.request.actionKey, WALLET_FUND_AUTHORIZE_ACTION);
  assert.equal(Object.prototype.hasOwnProperty.call(built.request, 'amount_cents'), false);
  let called = null;
  const result = await runWalletFundAuthorization({
    roles: ['owner'],
    requireStepUp: async (request) => {
      called = request.actionKey;
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.authorized, true);
  assert.equal(result.stopped, true);
  assert.equal(called, 'wallet.fund');
  const lib = sourceOf('../../src/lib/walletFundAuthorize.ts');
  const card = sourceOf('../../src/components/payments/WalletFundAuthorizeCard.tsx');
  assert.doesNotMatch(lib, /from ['"]@\/hooks\/useWallet/);
  assert.doesNotMatch(card, /fundWallet|useWallet|moov-wallet-fund/);
  assert.match(card, /Authorize \$0\.01 wallet\.fund/);
  assert.doesNotMatch(sourceOf('../../src/pages/AccountSecurity.tsx'), /WalletFundAuthorizeCard/);
  assert.doesNotMatch(sourceOf('../../src/pages/WalletOps.tsx'), /WalletFundAuthorizeCard/);
});

test('evaluateOneAuthorizedLegPost arms funding only when TOTP is consumed this phase', () => {
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  const held = evaluateOneAuthorizedLegPost({
    productionPostFlag: true,
    sandboxPostFlag: false,
    requestedLeg: 'funding',
    totpAction: MOOV_FUND_TOTP_ACTION,
    totpPresent: true,
    totpValid: true,
    persistDone: true,
    orchestratorAllows: true,
  });
  assert.equal(held.arm, false);
  assert.equal(held.reason, 'totp_not_consumed_this_phase');
  const armed = evaluateOneAuthorizedLegPost({
    productionPostFlag: true,
    sandboxPostFlag: false,
    requestedLeg: 'funding',
    totpAction: MOOV_FUND_TOTP_ACTION,
    totpPresent: true,
    totpValid: true,
    persistDone: true,
    orchestratorAllows: true,
    consumeTotpThisPhase: true,
  });
  assert.equal(armed.arm, true);
});

test('executeProductionWalletFunding POSTs once; payout POST stays blocked', async () => {
  let posts = 0;
  const posted = await executeProductionWalletFunding({
    credentials: { environment: 'production', publicKey: 'pk', secretKey: 'sk' },
    binding: fundBinding(),
    intent: { id: '11111111-1111-4111-8111-111111111111', idempotency_key: FUND_KEY, status: 'planned' },
    persistDone: true,
    orchestratorAllows: true,
    totpPresent: true,
    totpValid: true,
    consumeTotpThisPhase: true,
    transferPostEnabled: true,
    sandboxTransferPostEnabled: false,
    postTransfer: async () => {
      posts += 1;
      return {
        ok: true,
        status: 201,
        json: { transferID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'pending' },
        diagnosis: { request_id: 'req-1' },
      };
    },
  });
  assert.equal(posts, 1);
  assert.equal(posted.liveProviderPosted, true);
  assert.equal(posted.provider_transfer_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(posted.requestId, 'req-1');
  assert.equal(posted.leg, 'funding');

  const payout = await executeProductionWalletDisbursement({
    credentials: { environment: 'production', publicKey: 'pk', secretKey: 'sk' },
    binding: {
      ...KNOWN_APPROVED_MOOV.freedom,
      sourcePaymentMethodId: FREEDOM.walletPm,
      destinationPaymentMethodId: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
      amountCents: 1,
      accountId: FREEDOM.moovAccountId,
      platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
      recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
      recipientBankId: KNOWN_APPROVED_MOOV.recipient.bankId,
    },
    persistDone: true,
    orchestratorAllows: true,
    totpPresent: true,
    totpValid: true,
    consumeTotpThisPhase: true,
    transferPostEnabled: true,
    sandboxTransferPostEnabled: false,
    postTransfer: async () => {
      posts += 1;
      return { ok: true, status: 201, json: { transferID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
    },
  });
  assert.equal(posts, 1);
  assert.equal(payout.liveProviderPosted, false);
  assert.equal(payout.error, 'payout_post_blocked_phase_a');
});

test('e2e postPhase funding never posts payout and runner never logs TOTP', async () => {
  let fundingPosts = 0;
  const plan = await executeProductionPayoutE2e({
    tenantId: FREEDOM.tenantId,
    tenantEnvironment: 'production',
    liveAvailableCents: 0,
    recipientVerified: true,
    persistMoneyIntents: true,
    transferPostEnabled: true,
    sandboxTransferPostEnabled: false,
    totpFundPresent: true,
    totpFundValid: true,
    consumeTotpThisPhase: true,
    postPhase: 'funding',
    existingRows: [{
      id: '11111111-1111-4111-8111-111111111111',
      leg_role: 'wallet_funding',
      kind: 'wallet_funding',
      payout_operation_id: m714PayoutOperationId(),
      idempotency_key: FUND_KEY,
      status: 'planned',
      amount_cents: 1,
      environment: 'production',
    }],
    executeFunding: async (args) => {
      fundingPosts += 1;
      assert.equal(args.consumeTotpThisPhase, true);
      return {
        ok: true,
        outcome: 'posted',
        liveProviderPosted: true,
        provider_transfer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        requestId: 'req-e2e',
        provider_status: 'pending',
      };
    },
    executePayout: async () => {
      throw new Error('payout_primitive_invoked');
    },
  });
  assert.equal(fundingPosts, 1);
  assert.equal(plan.funding_provider_posts, 1);
  assert.equal(plan.payout_provider_posts, 0);
  assert.equal(plan.post_phase, 'funding');

  const runner = sourceOf('../providers/oneshot/m716-prod-penny-fund-run.mjs');
  assert.match(runner, /setProductionPostFlag\(false\)/);
  assert.match(runner, /postPhase: 'funding'/);
  assert.doesNotMatch(runner, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(runner, /totp_code|otpauth|Apple Passwords/);
  assert.match(runner, /WALLET.DISBURSE AUTHORIZATION CONSUMED/);
  assert.doesNotMatch(runner, /totpDisbursePresent: true/);
  const card = sourceOf('../../src/components/payments/WalletFundAuthorizeCard.tsx');
  assert.doesNotMatch(card, /console\.(log|info|debug|warn|error)/);
});

test('M7.16 overlay still refuses independent MUST_KEEP writers', () => {
  const primitives = sourceOf('../functions/api/providers/production/moov-production-transfer-primitives.mjs');
  assert.match(primitives, /payout_post_blocked_phase_a/);
  assert.match(primitives, /independent_must_keep_writer_blocked/);
});
