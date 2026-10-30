import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { groupLossDraftsByClaim, lossDraftGroupDetails } from '../../src/lib/lossDraftGroups.ts';

// Owner request: Loss Draft looks like the other check tabs (#1358): a title,
// the filter with one count/total line, a compact header per claim file and a
// compact card per check, instead of four stat cards and a wide table.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dashboard = read('src/components/loss-draft/LossDraftDashboard.tsx');
const filterBar = read('src/components/loss-draft/LossDraftDashboardCards.tsx');

test('Loss Draft renders through the shared compact list, not a wide table', () => {
  assert.match(dashboard, /from "@\/components\/check-review\/CompactCheckList"/);
  assert.match(dashboard, /<ScrollArea className=\{COMPACT_LIST_SCROLL_CLASS\}>/);
  assert.match(dashboard, /<CompactCheckListBody>/);
  assert.match(dashboard, /<CompactClaimGroupHeader[\s\S]*?details=\{lossDraftGroupDetails\(group\.drafts, escrowStatusLabel\)\}/);
  assert.match(dashboard, /<CompactCheckRow/);
  assert.doesNotMatch(dashboard, /<Table\b|<TableHead\b|<TableRow\b/);
  // The four big stat cards are gone; the filter is the compact bar.
  assert.doesNotMatch(dashboard, /<LossDraftDashboardCards\b/);
  assert.match(dashboard, /<LossDraftFilterBar\b/);
  // A short title like the other tabs.
  assert.match(dashboard, /<CardTitle className="text-sm flex items-center gap-2">[\s\S]*?Loss Draft\s*<\/CardTitle>/);
});

test('the loss-draft facts stay on the compact card', () => {
  for (const re of [
    /checkNumber=\{d\.check_number\}/,
    /amount=\{d\.check_amount \?\? d\.total_escrowed\}/,
    /d\.mortgage_servicer \|\| "No mortgage company"/,
    /<Badge className=\{`text-\[10px\] \$\{sc\.color\}`\}>\{sc\.label\}<\/Badge>/,
    /Returned from Mortgage Desk · Action Required/,
    /Escrowed \{formatCompactAmount\(escrowed\)\}/,
    /Released \{formatCompactAmount\(released\)\}/,
    /Holdback \{formatCompactAmount\(d\.holdback_amount\)\}/,
    /Draw \{d\.draw_stage\}/,
    /Not monitored/,
    /d\.is_stale &&/,
    /missing doc\{d\.missing_docs_count === 1 \? "" : "s"\}/,
    /Follow-up overdue/,
  ]) {
    assert.match(dashboard, re, String(re));
  }
});

test('actions and click behaviour are kept', () => {
  assert.match(dashboard, /onSelect=\{\(\) => setSelectedId\(d\.id\)\}/);
  assert.match(dashboard, /onClick=\{onSelect\}/);
  // New Loss Draft was removed from the tab (owner, 2026-10-29).
  assert.doesNotMatch(dashboard, /NewLossDraftDialog/);
  // The refresh button was removed too (owner, 2026-10-29).
  assert.doesNotMatch(dashboard, /Refresh loss drafts|RefreshCw/);
  assert.match(dashboard, /Back to list/);
  assert.match(dashboard, /<LossDraftDetailPanel/);
  // Returned-from-Desk drafts still sort first and keep their tint.
  assert.match(dashboard, /compareLossDraftReturnPriority\(/);
  assert.match(dashboard, /className=\{returned \? "bg-amber-500\/10" : ""\}/);
});

test('the filter is one bar with one count/total line', () => {
  assert.match(filterBar, /export function LossDraftFilterBar\b/);
  assert.match(filterBar, /border-b px-3 py-2 bg-muted\/30/);
  for (const v of ['active', 'monitored', 'non_monitored']) {
    assert.match(filterBar, new RegExp(`<SelectItem value="${v}">`), v);
  }
  assert.match(filterBar, /Unreleased: \$\{visibleUnreleased\.toLocaleString/);
  assert.match(dashboard, /visibleCount=\{prioritized\.length\}/);
});

const row = (id, extra = {}) => ({
  id, claim_id: null, claim_number: null, policyholder_name: null, payee_line: null,
  escrow_status: 'escrowed', unreleased_amount: 100, ...extra,
});

test('groupLossDraftsByClaim keeps first-appearance order and groups by claim', () => {
  const groups = groupLossDraftsByClaim([
    row('a', { claim_id: 'c2', claim_number: 'CLM-2', policyholder_name: 'Bo' }),
    row('b', { claim_id: 'c1', claim_number: 'CLM-1', policyholder_name: 'Al' }),
    row('c', { claim_id: 'c2', claim_number: 'CLM-2', policyholder_name: 'Bo' }),
    row('d', { claim_number: ' clm-9 ' }),
    row('e', { claim_number: 'CLM-9' }),
    row('f', { payee_line: 'JANE DOE AND BANK' }),
    row('g'),
  ], (p) => (p ? 'Jane Doe' : null));
  assert.deepEqual(groups.map((g) => g.drafts.map((d) => d.id)), [['a', 'c'], ['b'], ['d', 'e'], ['f'], ['g']]);
  assert.equal(groups[0].claimNumber, 'CLM-2');
  assert.equal(groups[0].policyholderName, 'Bo');
  assert.equal(groups[2].claimNumber, 'clm-9');
  assert.equal(groups[3].claimNumber, 'Unlinked claim');
  assert.equal(groups[3].policyholderName, 'Jane Doe');
  assert.equal(groups[4].policyholderName, 'Unknown insured');
});

test('lossDraftGroupDetails gives the status and the unreleased total', () => {
  const label = (s) => ({ escrowed: 'Escrowed', disputed: 'Disputed', partial_release: 'Partial Release' })[s] ?? s;
  assert.deepEqual(lossDraftGroupDetails([row('a', { unreleased_amount: 1234.5 })], label), ['Escrowed', '$1,234.50 unreleased']);
  assert.deepEqual(
    lossDraftGroupDetails([row('a'), row('b', { escrow_status: 'disputed', unreleased_amount: null })], label),
    ['Escrowed, Disputed', '$100.00 unreleased'],
  );
  assert.deepEqual(
    lossDraftGroupDetails([row('a'), row('b', { escrow_status: 'disputed' }), row('c', { escrow_status: 'partial_release' })], label)[0],
    '3 statuses',
  );
});
