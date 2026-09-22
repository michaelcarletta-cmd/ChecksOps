import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CONSUME_TOTP_THIS_PHASE,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  PAYMENT_AUTHORIZATION_ACTION,
  REQUIRE_TOTP_FALSE_PRODUCTION_PATH,
} from '../functions/api/providers/production/moov-payout-authorization.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('M7.18 keeps financial execution dark and totp required', () => {
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  assert.equal(PERSIST_MONEY_INTENTS_THIS_PHASE, false);
  assert.equal(REQUIRE_TOTP_FALSE_PRODUCTION_PATH, false);
  assert.equal(PAYMENT_AUTHORIZATION_ACTION, 'disbursement.send');
  const totp = sourceOf('../functions/api/auth-financial-totp.mjs');
  assert.match(totp, /resolvePayoutStepUpBinding/);
  assert.match(totp, /disbursement\.send/);
  assert.match(totp, /totp_code_must_not_be_stored/);
  assert.match(totp, /kind: 'payout'/);
  assert.doesNotMatch(totp, /requireTotp\s*[:=]\s*false/);
});

test('production host never falls through to Lovable money movers', () => {
  const orchestrate = sourceOf('../../src/lib/awsPayoutOrchestrate.ts');
  assert.match(orchestrate, /export const isChecksOpsProductionHost/);
  assert.match(orchestrate, /export const mustBlockLegacyMoneyMovers/);
  assert.match(orchestrate, /checksops\.com/);
  assert.match(orchestrate, /workflow: "payment"/);
  const consoleSrc = sourceOf('../../src/components/disbursement/DisbursementConsole.tsx');
  assert.match(consoleSrc, /mustBlockLegacyMoneyMovers/);
  assert.match(consoleSrc, /Authorize \{amountText\} payment/);
  assert.doesNotMatch(consoleSrc, /wallet\.fund/);
  assert.doesNotMatch(consoleSrc, /FUND_FIRST/);
  assert.doesNotMatch(consoleSrc, /M7\.18/);
  const awsBlock = consoleSrc.slice(
    consoleSrc.indexOf('mustBlockLegacyMoneyMovers'),
    consoleSrc.indexOf('calculate-payment-funding'),
  );
  assert.match(awsBlock, /Payment is recorded and waiting/);
});

test('penny authorization UI is unmounted from production settings', () => {
  const settings = sourceOf('../../src/components/white-label/WhiteLabelSettings.tsx');
  const security = sourceOf('../../src/pages/AccountSecurity.tsx');
  const walletOps = sourceOf('../../src/pages/WalletOps.tsx');
  assert.doesNotMatch(settings, /WalletFundAuthorizeCard/);
  assert.doesNotMatch(security, /WalletFundAuthorizeCard/);
  assert.doesNotMatch(walletOps, /WalletFundAuthorizeCard/);
  assert.doesNotMatch(walletOps, /PayoutOrchestratorPanel/);
});

test('oneshot penny inspect is read-only and overlay runner refuses armed POST', () => {
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, /inspect_m716_penny_intent/);
  assert.match(oneshot, /inspect_only: true/);
  assert.match(oneshot, /d4580db2-1a3a-4ff0-94ff-4f68af8bcd0f/);
  const runner = sourceOf('../providers/oneshot/m718-prod-payout-deploy-run.mjs');
  assert.match(runner, /refuseArmed/);
  assert.match(runner, /AWS_MOOV_TRANSFER_POST_ENABLED/);
  assert.match(runner, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
  assert.match(runner, /checksops-production-frontend-806168576068/);
  assert.doesNotMatch(runner, /update-function-configuration/);
  assert.doesNotMatch(runner, /--delete/);
});
