/**
 * WalletOps page order: Operating Balance first, then Wallet & Treasury and
 * Automatic Funding side by side, then Recent Wallet Activity full width.
 * Funding & Billing is hidden behind a flag; its billing rows stay in activity.
 * On phones (360-414px) nothing is wider than the viewport, and the Running
 * Balance card is gone from the bottom of the page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../../src/pages/WalletOps.tsx', import.meta.url), 'utf8');
const render = page.slice(page.indexOf('  return (\n    <div className="space-y-4">'));
const autoFunding = readFileSync(new URL('../../src/components/payments/AutoFundingPanel.tsx', import.meta.url), 'utf8');

test('WalletOps renders Operating Balance, then Wallet & Treasury | Automatic Funding, then Recent Wallet Activity', () => {
  const balance = render.indexOf('Available operating balance');
  const grid = render.indexOf('<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">');
  const treasury = render.indexOf('title="Wallet & Treasury"');
  const funding = render.indexOf('title="Automatic Funding"');
  const activity = render.indexOf('title="Recent Wallet Activity"');
  for (const at of [balance, grid, treasury, funding, activity]) assert.ok(at > 0);
  assert.ok(balance < grid && grid < treasury && treasury < funding && funding < activity);
  // Activity spans both columns of the two-column row.
  assert.match(render.slice(funding, activity), /<div className="min-w-0 lg:col-span-2">/);
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

test('the two-column row is one bounded column on phones, so no card is wider than the viewport', () => {
  // Without grid-cols-1 the implicit track is `auto` and grows to the widest
  // nowrap child (about 650px), which the route's overflow-x-hidden then clips.
  assert.ok(render.includes('<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">'));
  assert.doesNotMatch(render, /className="grid gap-4 lg:grid-cols-2"/);
  assert.match(page, /<Card className="min-w-0 overflow-hidden border-border\/60 shadow-sm">/);
  assert.match(page, /<CardHeader className="flex flex-row flex-wrap items-start justify-between/);
  assert.match(page, /<CardTitle className="flex min-w-0 items-center gap-2/);
});

test('Recent Wallet Activity rows wrap long names and keep amounts whole on phones', () => {
  const list = render.slice(render.indexOf('title="Recent Wallet Activity"'));
  assert.match(list, /className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2\.5 text-sm"/);
  assert.match(list, /<div className="min-w-0 flex-1">/);
  assert.match(list, /<p className="break-words font-medium">\{item\.title\}<\/p>/);
  assert.match(list, /<p className="break-words text-xs text-muted-foreground">\{item\.detail\}<\/p>/);
  assert.match(list, /<div className="shrink-0 text-right">/);
  assert.match(list, /<div className="flex shrink-0 items-center gap-2">/);
});

test('Automatic Funding: balance boxes, the toggle row and settings fit a phone', () => {
  assert.match(autoFunding, /<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">/);
  assert.match(autoFunding, /<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">/);
  assert.match(autoFunding, /<div className="min-w-0 rounded-md border p-3">/);
  // The label column shrinks and wraps; the Switch keeps its size beside it.
  const toggle = autoFunding.slice(autoFunding.indexOf('{/* Switch */}'), autoFunding.indexOf('{!authorized && ('));
  assert.match(toggle, /<div className="min-w-0 flex-1">/);
  assert.match(toggle, /<Switch[\s\S]*className="shrink-0"/);
});

test('WalletOps no longer shows a running balance at the bottom', () => {
  assert.doesNotMatch(page, /Running Balance/i);
  assert.doesNotMatch(page, /useWalletRunningBalance/);
  assert.doesNotMatch(page, /from "recharts"/);
  // Recent Wallet Activity is the last section on the page.
  const activity = render.indexOf('title="Recent Wallet Activity"');
  assert.equal(render.indexOf('<SectionCard', activity + 1), -1);
});
