/**
 * Owner 2026-11-14: "Make sure once a check is deposited the validity of the check is irrelevant
 * meaning the date issued does not matter for anyone it's already been deposited and not a
 * concern. There is no need to show the warning once a check is deposited."
 *
 * The issue-date validity warning (stale-dated / likely expired / expires in Nd) is shown in four
 * places, all on the website: the Check Command Center row badge (CheckValidityBadge), the check
 * detail banner (CheckCommandCenter.tsx), the review console banner and the review decision
 * confirm (CheckReviewConsole.tsx). Each goes through isCheckDeposited / checkValidityWarning.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assessCheckValidity,
  checkValidityWarning,
  isCheckDeposited,
} from '../../src/lib/checkValidity.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const REF = new Date(2026, 10, 14);
const OLD = '2026-01-02'; // 316 days before REF: "Likely expired"
const NEAR = '2026-05-28'; // 170 days before REF: "Expires in 10d"

test('the assessment itself is unchanged: an old check is still graded expired / warning', () => {
  assert.equal(assessCheckValidity(OLD, { referenceDate: REF }).risk, 'expired');
  assert.equal(assessCheckValidity(NEAR, { referenceDate: REF }).risk, 'warning');
});

test('a check that is not deposited keeps its warning', () => {
  for (const check of [
    { status: 'needs_review', check_stage: 'review' },
    { status: 'approved_for_deposit', check_stage: 'ready_for_deposit' },
    { status: 'endorsements_in_progress', check_stage: 'endorsing' },
    { status: 'reissue_requested', check_stage: null },
    {},
  ]) {
    assert.equal(isCheckDeposited(check), false, JSON.stringify(check));
    const w = checkValidityWarning({ ...check, issue_date: OLD }, { referenceDate: REF });
    assert.equal(w?.risk, 'expired', JSON.stringify(check));
    assert.equal(checkValidityWarning({ ...check, issue_date: NEAR }, { referenceDate: REF })?.risk, 'warning');
  }
});

test('a deposited check, or one past deposit, shows no warning however old it is', () => {
  for (const check of [
    { status: 'deposited', check_stage: 'deposited' },
    { status: 'needs_review', check_stage: 'deposited' },
    { status: 'deposited', check_stage: null },
    { status: 'released' },
    { status: 'cleared' },
    { status: 'settled' },
    { status: 'funds_released' },
    { check_stage: 'funds_released' },
    { check_stage: 'disbursed_externally' },
    { check_stage: 'cleared' },
    { status: 'DEPOSITED' },
    { status: 'approved_for_deposit', partner_status: 'deposited' },
    { status: 'approved_for_deposit', deposited_at: '2026-11-01T15:00:00Z' },
  ]) {
    assert.equal(isCheckDeposited(check), true, JSON.stringify(check));
    for (const issue_date of [OLD, NEAR]) {
      assert.equal(checkValidityWarning({ ...check, issue_date }, { referenceDate: REF }), null, JSON.stringify(check));
    }
  }
});

test('a returned check is not deposited: it has to be presented again, so the date matters again', () => {
  const returned = { status: 'returned', check_stage: 'returned', deposited_at: '2026-11-01T15:00:00Z' };
  assert.equal(isCheckDeposited(returned), false);
  assert.equal(checkValidityWarning({ ...returned, issue_date: OLD }, { referenceDate: REF })?.risk, 'expired');
});

test('no check, a safe age or no issue date is no warning', () => {
  assert.equal(isCheckDeposited(null), false);
  assert.equal(checkValidityWarning(null), null);
  assert.equal(checkValidityWarning({ status: 'needs_review', issue_date: '2026-11-01' }, { referenceDate: REF }), null);
  assert.equal(checkValidityWarning({ status: 'needs_review', issue_date: null }, { referenceDate: REF }), null);
});

test('every place the website shows the warning is gated on the deposit state', () => {
  const badge = read('src/components/checks/CheckValidityBadge.tsx');
  assert.match(badge, /if \(isCheckDeposited\(check\)\) return null;/);

  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /<CheckValidityBadge issueDate=\{check\.issue_date\} expirationDays=\{check\.expiration_days\} check=\{check\} hideWhenSafe \/>/);
  assert.match(ccc, /const v = checkValidityWarning\(check, \{/);
  assert.doesNotMatch(ccc, /assessCheckValidity\(/);
  assert.equal((ccc.match(/<CheckValidityBadge /g) ?? []).length, 1);

  const console_ = read('src/components/check-review/CheckReviewConsole.tsx');
  assert.match(console_, /const v = checkValidityWarning\(check, \{/);
  assert.match(console_, /const v = checkValidityWarning\(effectiveCheck, \{/);
  assert.doesNotMatch(console_, /assessCheckValidity\(|isAtRisk\(/);
});
