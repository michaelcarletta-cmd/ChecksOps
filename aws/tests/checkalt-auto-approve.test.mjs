import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_APPROVE_POLICY_SOURCE,
  AUTO_APPROVE_SKIP_REASONS,
  decideAutoApprove,
  depositIsFlagged,
  isCheckAltApproveLockError,
  resolveAutoApprovePolicy,
  safeCheckAltReference,
} from '../functions/api/providers/production/checkalt-submit.mjs';
import { checkAltAutoApproveSkipText } from '../../src/lib/checkAltAutoApproveSkip.ts';

const clean = {
  processRequiresApproval: true,
  reference: '9001',
  amountCents: 154672,
  flagged: false,
};

test('decideAutoApprove: always on, no ceiling, no Low Risk gate; approves every unflagged, referenced deposit', () => {
  assert.deepEqual(decideAutoApprove(clean), { approve: true, skipReason: null });
  // No amount ceiling: any positive integer amount approves.
  for (const amountCents of [1, 200000, 200001, 99999999, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(decideAutoApprove({ ...clean, amountCents }), { approve: true, skipReason: null }, String(amountCents));
  }
  // The old tenant setting and ceiling inputs are ignored.
  assert.equal(decideAutoApprove({ ...clean, enabled: false }).approve, true);
  assert.equal(decideAutoApprove({ ...clean, maxCents: null }).approve, true);
  assert.equal(decideAutoApprove({ ...clean, maxCents: 100, amountCents: 200001 }).approve, true);
  const skip = (over) => decideAutoApprove({ ...clean, ...over }).skipReason;
  assert.equal(skip({ flagged: true }), 'flagged_by_checkalt');
  assert.equal(skip({ reference: null }), 'missing_reference');
  assert.equal(skip({ reference: '' }), 'missing_reference');
  assert.equal(skip({ processRequiresApproval: false }), 'not_pending_approval');
  // Option A (owner 2026-10-24): no Low Risk gate; an old riskLow input is ignored.
  assert.deepEqual(decideAutoApprove({ ...clean, riskLow: false }), { approve: true, skipReason: null });
  assert.deepEqual(decideAutoApprove({ ...clean, riskLow: undefined }), { approve: true, skipReason: null });
  assert.equal(skip({ reference: 'abc' }), 'invalid_reference');
  assert.equal(skip({ reference: '0' }), 'invalid_reference');
  assert.equal(skip({ reference: '99999999999999999999' }), 'invalid_reference');
  assert.equal(skip({ reference: 9001 }), null);
  assert.equal(skip({ amountCents: 0 }), 'invalid_amount');
  assert.equal(skip({ amountCents: -5 }), 'invalid_amount');
  assert.equal(skip({ amountCents: 12.5 }), 'invalid_amount');
  assert.equal(skip({ amountCents: null }), 'invalid_amount');
  assert.equal(skip({ amountCents: '500' }), 'invalid_amount');
  // Guard order: a flagged item never reaches the amount check.
  assert.equal(skip({ flagged: true, amountCents: 0 }), 'flagged_by_checkalt');
  assert.equal(skip({ riskLow: false, amountCents: 0 }), 'invalid_amount');
});

test('resolveAutoApprovePolicy: always on for every organization, no ceiling, settings ignored', () => {
  const always = { enabled: true, maxCents: null, source: 'always_on' };
  assert.equal(AUTO_APPROVE_POLICY_SOURCE, 'always_on');
  assert.deepEqual(resolveAutoApprovePolicy(), always);
  assert.deepEqual(resolveAutoApprovePolicy({ auto_approve_enabled: false, auto_approve_max_cents: 100 }), always);
  assert.deepEqual(resolveAutoApprovePolicy({ auto_approve_enabled: true, auto_approve_max_cents: null }), always);
  assert.deepEqual(resolveAutoApprovePolicy(null, { auto_approve_enabled: false, auto_approve_max_cents: 0 }), always);
  assert.deepEqual(resolveAutoApprovePolicy(null, null), always);
});

test('AUTO_APPROVE_SKIP_REASONS: the setting and ceiling reasons are gone; risk_not_low stays listed for old rows', () => {
  for (const gone of ['auto_approve_disabled', 'missing_auto_approve_ceiling', 'over_max_amount']) {
    assert.equal(AUTO_APPROVE_SKIP_REASONS.includes(gone), false, gone);
  }
  for (const kept of ['not_pending_approval', 'missing_reference', 'invalid_reference', 'flagged_by_checkalt', 'risk_not_low', 'invalid_amount']) {
    assert.equal(AUTO_APPROVE_SKIP_REASONS.includes(kept), true, kept);
  }
});

test('depositIsFlagged: CheckAlt flags block; clean riskRating keys do not', () => {
  assert.equal(depositIsFlagged({
    status: 40, statusDescription: 'Pending Approval', riskRating: 2, riskRatingDescription: 'Low Risk', errors: [],
  }), false);
  assert.equal(depositIsFlagged({
    status: 40,
    statusDescription: 'Pending Approval',
    riskRating: 'Accepted',
    riskRatingDescription: 'High Risk',
    duplicateStatus: 'false',
    ocrAmountStatus: 'True',
    amountDiscrepancyDetected: false,
    errors: [],
  }), false);
  assert.equal(depositIsFlagged({ exceptions: ['x'] }), true);
  assert.equal(depositIsFlagged({ warnings: ['x'] }), true);
  assert.equal(depositIsFlagged({ riskFactors: ['x'] }), true);
  assert.equal(depositIsFlagged({ errors: ['x'] }), true);
  assert.equal(depositIsFlagged({ amountDiscrepancyDetected: true }), true);
  assert.equal(depositIsFlagged({ amountDiscrepancyDetected: 'true' }), true);
  assert.equal(depositIsFlagged({ statusDescription: 'Possible duplicate item' }), true);
  assert.equal(depositIsFlagged(null), false);
});

test('depositIsFlagged: FinCapture duplicateStatus, riskRating Decline/Warning and ocrAmountStatus False flag', () => {
  for (const duplicateStatus of [true, 'true', 'True', ' TRUE ']) {
    assert.equal(depositIsFlagged({ duplicateStatus }), true, String(duplicateStatus));
  }
  for (const duplicateStatus of [false, 'false', 'False', null, undefined, '']) {
    assert.equal(depositIsFlagged({ duplicateStatus }), false, String(duplicateStatus));
  }
  for (const riskRating of ['Decline', 'decline', 'Warning', ' WARNING ']) {
    assert.equal(depositIsFlagged({ riskRating }), true, riskRating);
  }
  for (const riskRating of ['Accepted', 'accepted', 2, null, '']) {
    assert.equal(depositIsFlagged({ riskRating }), false, String(riskRating));
  }
  for (const ocrAmountStatus of [false, 'False', 'false']) {
    assert.equal(depositIsFlagged({ ocrAmountStatus }), true, String(ocrAmountStatus));
  }
  for (const ocrAmountStatus of [true, 'True', null, undefined]) {
    assert.equal(depositIsFlagged({ ocrAmountStatus }), false, String(ocrAmountStatus));
  }
  assert.equal(depositIsFlagged({ errors: [{ code: 1, message: 'x' }] }), true);
  assert.equal(depositIsFlagged({ errors: [] }), false);
});

test('depositIsFlagged: Pending, Pending Approval and Validation Failure status text is not a flag', () => {
  for (const statusDescription of ['Pending', 'Pending Approval', 'Validation Failure', '0: Validation Failure']) {
    assert.equal(depositIsFlagged({ status: 40, statusDescription }), false, statusDescription);
  }
  // riskRatingDescription is free text and never decides on its own.
  for (const riskRatingDescription of ['High Risk', 'Medium Risk', 'Risk review', '']) {
    assert.equal(depositIsFlagged({ riskRatingDescription }), false, riskRatingDescription);
  }
});

test('isCheckAltApproveLockError: only 404 locate/locked retries', () => {
  assert.equal(isCheckAltApproveLockError(404, { message: 'Unable to locate transaction' }), true);
  assert.equal(isCheckAltApproveLockError(404, { statusDescription: 'Item locked' }), true);
  assert.equal(isCheckAltApproveLockError(404, { message: 'not found' }), false);
  assert.equal(isCheckAltApproveLockError(500, { message: 'locked' }), false);
});

test('safeCheckAltReference: positive safe integers only', () => {
  assert.equal(safeCheckAltReference('123733567'), 123733567);
  assert.equal(safeCheckAltReference(9001), 9001);
  for (const bad of [null, undefined, '', '0', '-1', '1.5', '1e5', 'abc', '9007199254740993']) {
    assert.equal(safeCheckAltReference(bad), null, String(bad));
  }
});

test('checkAltAutoApproveSkipText: plain words for every server skip reason, none once approved', () => {
  const text = (skip_reason, extra = {}) => checkAltAutoApproveSkipText({ _auto_approve: { phase: 'skipped', approved: false, skip_reason, ...extra } });
  assert.equal(text('flagged_by_checkalt'), 'Check Alt flagged this check');
  assert.match(text('risk_not_low'), /before 2026-10-24/);
  for (const reason of AUTO_APPROVE_SKIP_REASONS) {
    const words = text(reason);
    assert.equal(typeof words, 'string', reason);
    assert.notEqual(words, 'Not approved automatically', `${reason} needs its own wording`);
    assert.doesNotMatch(words, /_/, reason);
  }
  // Rows submitted before always-on still read plainly.
  assert.match(text('auto_approve_disabled'), /auto-approve was off/);
  assert.match(text('over_max_amount'), /old amount limit/);
  assert.equal(text('something_new'), 'Not approved automatically');
  assert.equal(checkAltAutoApproveSkipText({ _auto_approve: { phase: 'attempting', approved: false, skip_reason: null } }),
    'ChecksOps started the automatic approval but did not get an answer');
  assert.equal(checkAltAutoApproveSkipText({ _auto_approve: { phase: 'outcome', approved: true, skip_reason: null } }), null);
  assert.equal(checkAltAutoApproveSkipText({ statusDescription: 'Pending Approval' }), null);
  assert.equal(checkAltAutoApproveSkipText(null), null);
  assert.equal(checkAltAutoApproveSkipText('x'), null);
});
