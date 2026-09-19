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

test('WalletOps panel omits raw provider IDs and does not dual-trigger', () => {
  const panel = sourceOf('src/components/payments/PayoutOrchestratorPanel.tsx');
  const page = sourceOf('src/pages/WalletOps.tsx');
  const hook = sourceOf('src/hooks/usePayoutOrchestrator.ts');
  assert.match(page, /PayoutOrchestratorPanel/);
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
