import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { format } from 'date-fns';
import { formatIssueDateDisplay, parseIssueDate } from '../../src/lib/issueDate.ts';
import { isInReviewQueue } from '../../src/lib/reviewQueueQuery.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_DISPLAY = 'Aug 20, 2026';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const unsafeFormat = (issueDate) => {
  const [y, m, d] = String(issueDate).split('-').map(Number);
  return format(new Date(y, m - 1, d), 'MMM d, yyyy');
};

test('YYYY-MM-DD and ISO timestamps display the same calendar date', () => {
  assert.equal(formatIssueDateDisplay('2026-08-20'), EXPECTED_DISPLAY);
  assert.equal(formatIssueDateDisplay('2026-08-20T00:00:00.000Z'), EXPECTED_DISPLAY);
  const parsedPlain = parseIssueDate('2026-08-20');
  const parsedIso = parseIssueDate('2026-08-20T00:00:00.000Z');
  assert.equal(parsedPlain?.getFullYear(), 2026);
  assert.equal(parsedPlain?.getMonth(), 7);
  assert.equal(parsedPlain?.getDate(), 20);
  assert.equal(parsedIso?.getFullYear(), 2026);
  assert.equal(parsedIso?.getMonth(), 7);
  assert.equal(parsedIso?.getDate(), 20);
});

test('null, empty, and malformed issue_date never throw and render fallback', () => {
  for (const value of [null, undefined, '', '   ', 'not-a-date', '2026-13-40', '2026-02-31']) {
    assert.doesNotThrow(() => formatIssueDateDisplay(value));
    assert.equal(parseIssueDate(value), null);
    assert.equal(formatIssueDateDisplay(value), '—');
  }
});

test('unsafe split("-").map(Number) throws on ISO timestamps; helper does not', () => {
  const iso = '2026-08-20T00:00:00.000Z';
  assert.throws(() => unsafeFormat(iso), /Invalid time value/);
  assert.doesNotThrow(() => formatIssueDateDisplay(iso));
  assert.equal(formatIssueDateDisplay(iso), EXPECTED_DISPLAY);
});

test('ReviewDecisionPanel render path does not throw on live issue_date shapes', () => {
  const renderReviewIssueDate = (check) => {
    if (!check.issue_date) return null;
    return formatIssueDateDisplay(check.issue_date);
  };
  const rows = [
    { issue_date: '2026-08-20T00:00:00.000Z' },
    { issue_date: '2026-08-20' },
    { issue_date: null },
    { issue_date: '' },
    { issue_date: 'bad' },
  ];
  for (const row of rows) {
    assert.doesNotThrow(() => renderReviewIssueDate(row));
  }
  assert.equal(renderReviewIssueDate(rows[0]), EXPECTED_DISPLAY);
  assert.equal(renderReviewIssueDate(rows[1]), EXPECTED_DISPLAY);
  assert.equal(renderReviewIssueDate(rows[2]), null);
});

test('Review call sites use the shared helper instead of split parse', () => {
  const consoleSrc = read('src/components/check-review/CheckReviewConsole.tsx');
  const cccSrc = read('src/pages/CheckCommandCenter.tsx');
  const depositSrc = read('src/components/deposit-ops/DepositOperationsConsole.tsx');
  assert.match(consoleSrc, /formatIssueDateDisplay\(check\.issue_date\)/);
  assert.equal(consoleSrc.includes('split("-").map(Number)'), false);
  assert.match(cccSrc, /formatIssueDateDisplay\(value\)/);
  assert.equal(cccSrc.includes('split("-").map(Number)'), false);
  assert.match(depositSrc, /formatIssueDateDisplay\(checkData\.issue_date\)/);
  assert.equal(depositSrc.includes('split("-").map(Number)'), false);
});

test('Review queue filter still counts 30 review rows', () => {
  const review = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`,
    check_stage: 'review',
    status: 'needs_review',
    ocr_status: 'complete',
    issue_date: i % 2 === 0 ? '2026-08-20T00:00:00.000Z' : '2026-08-20',
  }));
  const endorsing = Array.from({ length: 24 }, (_, i) => ({
    id: `e${i}`,
    check_stage: 'endorsing',
    status: 'endorsements_in_progress',
    ocr_status: 'complete',
    issue_date: '2026-08-20T00:00:00.000Z',
  }));
  const rows = [...review, ...endorsing];
  assert.equal(rows.filter(isInReviewQueue).length, 30);
  assert.equal(rows.filter((row) => row.check_stage === 'endorsing').length, 24);
  for (const row of rows) {
    assert.doesNotThrow(() => formatIssueDateDisplay(row.issue_date));
  }
});
