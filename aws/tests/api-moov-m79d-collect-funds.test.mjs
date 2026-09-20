import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertNoCrossEnvironmentObject } from '../functions/api/providers/moov-environment.mjs';
import {
  orchestratePayout,
  payoutOperationIdFor,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const SANDBOX_RECIPIENT = '90050a69-84f3-41bb-aa30-490ca7e7bf34';

test('M7.9D runner never arms POST, never posts transfers, never creates duplicate objects', () => {
  const src = sourceOf('../providers/oneshot/m79d-run.mjs');
  assert.match(src, new RegExp(PIPELINE));
  assert.match(src, new RegExp(SANDBOX_ACCOUNT));
  assert.match(src, new RegExp(SANDBOX_WALLET));
  assert.match(src, new RegExp(SANDBOX_BANK));
  assert.match(src, /capabilities: \['collect-funds.ach'\]/);
  assert.match(src, /geographicReach: 'us-only'/);
  assert.match(src, /collectFunds: \{/);
  assert.match(src, /monthlyVolumeRange: 'under-10k'/);
  assert.match(src, /filePurpose', 'merchant_underwriting'/);
  assert.match(src, /business.underwriting-documents-tier-one/);
  assert.match(src, /STOP_FOR_REVIEW/);
  assert.match(src, /capability: 'collect-funds.ach'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /path: '\/accounts',\s*[\s\S]{0,40}method: 'POST'/);
  assert.doesNotMatch(src, /\/bank-accounts',\s*[\s\S]{0,40}method: 'POST'/);
  assert.doesNotMatch(src, /console\.log\(.*MOOV_SANDBOX_SECRET_KEY\)/);
  assert.equal((src.match(/SAFE_TO_ARM_ONLY_AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED:/g) || []).length, 1);
});

test('dark FUND_FIRST binds Pipeline Test sandbox bank and wallet without posting', async () => {
  const plan = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    recipientVerified: true,
    transferPostEnabled: false,
    persistMoneyIntents: false,
    environment: 'sandbox',
    tenantId: PIPELINE,
    labels: {
      fund: {
        sourceLabel: 'JPMORGAN CHASE BANK, NA ••••4321',
        destinationLabel: 'Sandbox wallet',
        bankId: SANDBOX_BANK,
        walletId: SANDBOX_WALLET,
      },
      disburse: {
        sourceLabel: 'Sandbox wallet',
        destinationLabel: 'Sandbox recipient bank',
        recipientLabel: 'Pipeline Test Payee',
        recipientId: SANDBOX_RECIPIENT,
      },
    },
  });
  assert.equal(plan.decision, 'FUND_FIRST');
  assert.equal(plan.shortfall_cents, 1);
  assert.equal(plan.available_cents, 0);
  assert.equal(plan.live_provider_posted, false);
  assert.equal(plan.persist_money_intents, false);
  assert.equal(plan.transfer_post_enabled, false);
  assert.equal(plan.created_payment_transfer, false);
  assert.equal(plan.funding_intent.source_bank_id, SANDBOX_BANK);
  assert.equal(plan.funding_intent.destination_wallet_id, SANDBOX_WALLET);
  assert.notEqual(plan.funding_intent.source_bank_id, '61062c38-a79e-4f62-bb64-32ddecf3d37c');
  assert.notEqual(plan.ux.funding_source, 'Wells Fargo ••••4573');
  assert.equal(plan.environment, 'sandbox');
  assert.equal(payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: SANDBOX_RECIPIENT,
    payoutCents: 1,
  }).length > 0, true);
});

test('sandbox object guard still denies Freedom IDs', () => {
  const denied = assertNoCrossEnvironmentObject({
    environment: 'sandbox',
    accountId: '60922058-7eca-4889-81dd-5720d7b9de96',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'cross_environment_object_refused');
});
