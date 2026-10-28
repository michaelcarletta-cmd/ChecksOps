/**
 * WalletOps page order: Operating Balance first, then Wallet & Treasury and
 * Automatic Funding side by side, then Recent Wallet Activity full width.
 * Funding & Billing is hidden behind a flag; its billing rows stay in activity.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../../src/pages/WalletOps.tsx', import.meta.url), 'utf8');
const render = page.slice(page.indexOf('  return (\n    <div className="space-y-4">'));

test('WalletOps renders Operating Balance, then Wallet & Treasury | Automatic Funding, then Recent Wallet Activity', () => {
  const balance = render.indexOf('Available operating balance');
  const grid = render.indexOf('<div className="grid gap-4 lg:grid-cols-2">');
  const treasury = render.indexOf('title="Wallet & Treasury"');
  const funding = render.indexOf('title="Automatic Funding"');
  const activity = render.indexOf('title="Recent Wallet Activity"');
  for (const at of [balance, grid, treasury, funding, activity]) assert.ok(at > 0);
  assert.ok(balance < grid && grid < treasury && treasury < funding && funding < activity);
  // Activity spans both columns of the two-column row.
  assert.match(render.slice(funding, activity), /<div className="lg:col-span-2">/);
});

test('Funding & Billing is hidden behind a flag, not deleted', () => {
  assert.match(page, /^const SHOW_FUNDING_AND_BILLING = false;$/m);
  const gate = render.indexOf('{SHOW_FUNDING_AND_BILLING && (');
  const section = render.indexOf('title="Funding & Billing"');
  assert.ok(gate > 0 && gate < section);
  assert.ok(section < render.indexOf('title="Wallet & Treasury"'));
  assert.equal((render.match(/title="Funding & Billing"/g) || []).length, 1);
});

test('Recent Wallet Activity lists billing, transfers, ledger entries and automatic payouts', () => {
  const list = page.slice(page.indexOf('const recentActivity = ['), page.indexOf('async function handleRefreshBalances'));
  assert.match(list, /\.\.\.billingActivity\.map/);
  assert.match(list, /kind: "billing" as const/);
  assert.match(list, /\.\.\.classifiedTransfers/);
  assert.match(list, /kind: "transfer" as const/);
  assert.match(list, /\.\.\.ledger\.map/);
  assert.match(list, /kind: "ledger" as const/);
  assert.match(list, /\.\.\.sweepActivity\.rows\.map/);
  assert.match(list, /kind: "sweep" as const/);
});
