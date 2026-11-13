// Owner, 2026-11-13: "one time transfer to bank is the same as add funds near sweeps. Remove the one time
// transfer since add funds is identical." The Automatic funding panel's "One-time transfer from your bank"
// box called the same funding path as Add funds; it is removed. Add funds stays on Wallet & Treasury.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('Automatic funding panel has no one-time transfer; Add funds remains on Wallet & Treasury', () => {
  const panel = read('src/components/payments/AutoFundingPanel.tsx');
  assert.doesNotMatch(panel, />\s*One-time transfer from your bank\s*</);
  assert.doesNotMatch(panel, /handleManualFund/);
  assert.doesNotMatch(panel, /fund\.mutateAsync/);
  // The automatic funding settings themselves stay.
  assert.match(panel, /Save funding settings/);
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /Add funds/);
  assert.match(page, /<AutoFundingPanel canEdit=\{isAdmin\} \/>/);
});
