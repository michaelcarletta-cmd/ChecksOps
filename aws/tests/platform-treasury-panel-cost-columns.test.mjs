/**
 * Platform owner "Wallet & P&L" screen (PlatformTreasuryPanel): provider cost is shown in two
 * columns (check processing, disbursements) in both tables, the provider monthly minimums are
 * a reference line only, a failed P&L read is named instead of shown as $0, and no text on the
 * screen names a payment provider (owner 2026-11-26). Source-text test: the panel is read as
 * text, not rendered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const panel = fs.readFileSync(path.join(REPO, 'src/components/admin/PlatformTreasuryPanel.tsx'), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('both tables carry a check processing and a disbursements cost column', () => {
  assert.equal(count(panel, '<TableHead className="text-right">Check processing</TableHead>'), 2);
  assert.equal(count(panel, '<TableHead className="text-right">Disbursements</TableHead>'), 2);
  assert.equal(panel.includes('>Provider cost</TableHead>'), false, 'the single combined column is gone');
  // One shared pair of cells, used by the monthly rows and the organization rows.
  assert.match(panel, /<CostCells row=\{m\} \/>/);
  assert.match(panel, /<CostCells row=\{t\} \/>/);
  for (const header of ['Month', 'Organization']) assert.ok(panel.includes(`<TableHead>${header}</TableHead>`), header);
  for (const header of ['Revenue', 'Profit', 'Volume']) {
    assert.equal(count(panel, `<TableHead className="text-right">${header}</TableHead>`), 2, header);
  }
});

test('the cost parts are read from the provider-neutral keys, with the older keys as fallback', () => {
  assert.match(panel, /b\?\.check_processing_cost_cents/);
  assert.match(panel, /b\?\.disbursement_cost_cents/);
  assert.ok(panel.indexOf('b?.check_processing_cost_cents') < panel.indexOf('b?.checkalt_cost_cents'));
  assert.ok(panel.indexOf('b?.disbursement_cost_cents') < panel.indexOf('b?.moov_cost_cents'));
  // A part the response does not carry is a dash, never $0.
  assert.match(panel, /cents === null \? "—" : money\(cents\)/);
});

test('the reference lines and the unavailable-sources warning read the response', () => {
  assert.match(panel, /cost_basis\?\.provider_minimums/);
  assert.match(panel, /cost_basis\?\.rates/);
  assert.match(panel, /pnl\?\.sources_unavailable/);
  assert.match(panel, /are not included in provider cost or\s+profit\./);
  assert.match(panel, /Provider cost is estimated from per-item rates:/);
  assert.match(panel, /Some figures could not be loaded:/);
  assert.match(panel, /role="alert"/);
  // The rates and minimums come from the response: no amount is typed into the panel.
  assert.equal(/\b(68|25|40)\s*¢|\$\s?1,000|\$\s?500\b/.test(panel), false);
  for (const source of ['tenants', 'collected_revenue', 'payouts', 'check_deposits', 'test_account_flag']) {
    assert.match(panel, new RegExp(`\\b${source}: "[a-z ]+",`), source);
  }
});

test('the card captions carry the real meanings', () => {
  for (const gone of ['Platform fees billed to organizations', 'Money out to the payment rails', 'transfers moved', 'Revenue less rail cost']) {
    assert.equal(panel.includes(gone), false, gone);
  }
  assert.ok(panel.includes('Collected from organizations'));
  assert.ok(panel.includes('Revenue less provider cost'));
  assert.match(panel, /plural\(payoutCount\(totals\), "payout", "payouts"\)\} completed/);
  assert.ok(panel.includes('`Check processing ${partMoney(totalCheckCost)} · Disbursements ${partMoney(totalDisbursementCost)}`'));
});

test('nothing on the screen names a payment provider', () => {
  // Scope: the whole source without comments, minus the snake_case response field names that
  // carry a provider name (moov_cost_cents, checkalt_per_check_cents, ...). Those are data
  // keys read as fallbacks, never rendered. Everything else - every string literal, JSX text,
  // identifier and import - must be free of the provider names.
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\b(?:moov|checkalt)_[a-z_]+\b/g, '');
  assert.equal(/moov|check ?alt/i.test(code), false, code.match(/.*(?:moov|check ?alt).*/i)?.[0]);
  // The scoping is not vacuous: the fallback keys are there.
  assert.match(panel, /checkalt_cost_cents/);
  assert.match(panel, /moov_cost_cents/);
});
