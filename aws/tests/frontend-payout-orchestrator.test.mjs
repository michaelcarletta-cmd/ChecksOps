import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  exclusivePayoutActions,
  moneyCents,
  PAYOUT_UX_LABEL,
  PAYOUT_UX_STAGES,
} from '../../src/lib/payoutOrchestrator.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('WalletOps payout copy matches the required lifecycle and amounts', () => {
  assert.deepEqual([...PAYOUT_UX_STAGES], [
    'funding_required',
    'funding_pending',
    'funds_available',
    'ready_to_send',
    'payment_pending',
    'payment_completed',
  ]);
  assert.equal(PAYOUT_UX_LABEL.funding_required, 'Funding required');
  assert.equal(PAYOUT_UX_LABEL.ready_to_send, 'Ready to send');
  assert.equal(moneyCents(1), '$0.01');
  assert.equal(moneyCents(0), '$0.00');
});

test('UI cannot enable fund and payout at the same time', () => {
  for (const stage of PAYOUT_UX_STAGES) {
    const actions = exclusivePayoutActions(stage);
    assert.equal(actions.both_enabled, false);
    assert.equal(Boolean(actions.prepare_funding && actions.prepare_payout), false);
    assert.equal(actions.submit_funding, false);
    assert.equal(actions.submit_payout, false);
  }
  assert.equal(exclusivePayoutActions('funding_required').prepare_funding, true);
  assert.equal(exclusivePayoutActions('ready_to_send').prepare_payout, true);
});

test('debug payout panel omits raw provider IDs and does not dual-trigger', () => {
  const panel = sourceOf('src/components/payments/PayoutOrchestratorPanel.tsx');
  const page = sourceOf('src/pages/WalletOps.tsx');
  const hook = sourceOf('src/hooks/usePayoutOrchestrator.ts');
  assert.doesNotMatch(page, /PayoutOrchestratorPanel/);
  assert.doesNotMatch(page, /Shortfall-aware/);
  assert.doesNotMatch(page, /Funding required/);
  assert.doesNotMatch(page, /Funding pending/);
  assert.doesNotMatch(page, /Funds available/);
  assert.doesNotMatch(page, /Ready to send/);
  assert.doesNotMatch(page, /Payment pending/);
  assert.doesNotMatch(page, /Payment completed/);
  assert.match(page, /MoovEnvironmentBadge/);
  assert.match(panel, /Admin\/debug payout-orchestration view/);
  assert.match(panel, /Prepare funding/);
  assert.match(panel, /Prepare payout/);
  assert.match(panel, /if \(!canPrepareFunding \|\| canPreparePayout\) return/);
  assert.match(panel, /if \(!canPreparePayout \|\| canPrepareFunding\) return/);
  assert.match(panel, /Wells Fargo ••••4573/);
  assert.match(panel, /Chase ••••1506/);
  assert.doesNotMatch(panel, /62a858ff-ee6a-49d7-9898-1c8e4a44227b/);
  assert.doesNotMatch(panel, /3e6286ca-a19c-45f6-aad9-f73dac5f0358/);
  assert.doesNotMatch(panel, /72eb66c1-d9a9-4f85-ab50-8871db9ceeea/);
  assert.doesNotMatch(panel, /a02c1c81-9ca6-434d-accc-ea4471a70ef2/);
  assert.match(hook, /moov-payout-orchestrate/);
  assert.doesNotMatch(hook, /moov-wallet-fund/);
  assert.doesNotMatch(hook, /moov-disburse/);
});

test('backend shortfall orchestrator remains available after WalletOps UI hide', () => {
  const orchestrator = sourceOf('aws/functions/api/providers/production/moov-payout-orchestrator.mjs');
  const handler = sourceOf('aws/functions/api/providers/production/moov-payout-orchestrate.mjs');
  const catalog = sourceOf('aws/functions/api/providers/catalog.mjs');
  const e2e = sourceOf('aws/functions/api/providers/production/moov-sandbox-payout-e2e.mjs');
  assert.match(orchestrator, /Dark, server-authoritative shortfall-aware payout orchestrator/);
  assert.match(orchestrator, /funding_required: 'Funding required'/);
  assert.match(orchestrator, /ready_to_send: 'Ready to send'/);
  assert.match(handler, /handleProductionMoovPayoutOrchestrate/);
  assert.match(catalog, /moov-payout-orchestrate/);
  assert.match(e2e, /M711_PHASE = 'M7.11'/);
  assert.match(e2e, /M712_PHASE = 'M7.12'/);
});
