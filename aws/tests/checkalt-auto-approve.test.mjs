import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_APPROVE_POLICY_SOURCE,
  AUTO_APPROVE_SKIP_REASONS,
  decideAutoApprove,
  depositHoldReason,
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
  // Option 1 (owner 2026-11-02): each hold records its own reason code, ahead of the amount check.
  for (const holdReason of ['held_duplicate', 'held_amount_mismatch', 'held_ocr_amount_mismatch', 'held_risk_decline']) {
    assert.equal(skip({ holdReason }), holdReason);
    assert.equal(skip({ holdReason, amountCents: 0 }), holdReason);
  }
  assert.deepEqual(decideAutoApprove({ ...clean, holdReason: null }), { approve: true, skipReason: null });
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
  for (const kept of ['not_pending_approval', 'missing_reference', 'invalid_reference', 'flagged_by_checkalt', 'risk_not_low', 'invalid_amount',
    'held_duplicate', 'held_amount_mismatch', 'held_ocr_amount_mismatch', 'held_risk_decline']) {
    assert.equal(AUTO_APPROVE_SKIP_REASONS.includes(kept), true, kept);
  }
});

test('depositHoldReason (Option 1, owner 2026-11-02): only a duplicate, an amount mismatch or Decline holds, each with its own code', () => {
  assert.equal(depositHoldReason({
    status: 40, statusDescription: 'Pending Approval', riskRating: 2, riskRatingDescription: 'Low Risk', errors: [],
  }), null);
  assert.equal(depositHoldReason({
    status: 40,
    statusDescription: 'Pending Approval',
    riskRating: 'Accepted',
    riskRatingDescription: 'High Risk',
    duplicateStatus: 'false',
    ocrAmountStatus: 'True',
    amountDiscrepancyDetected: false,
    errors: [],
  }), null);
  for (const duplicateStatus of [true, 'true', 'True', ' TRUE ']) {
    assert.equal(depositHoldReason({ duplicateStatus }), 'held_duplicate', String(duplicateStatus));
  }
  for (const duplicateStatus of [false, 'false', 'False', null, undefined, '']) {
    assert.equal(depositHoldReason({ duplicateStatus }), null, String(duplicateStatus));
  }
  for (const amountDiscrepancyDetected of [true, 'true']) {
    assert.equal(depositHoldReason({ amountDiscrepancyDetected }), 'held_amount_mismatch', String(amountDiscrepancyDetected));
  }
  for (const ocrAmountStatus of [false, 'False', 'false']) {
    assert.equal(depositHoldReason({ ocrAmountStatus }), 'held_ocr_amount_mismatch', String(ocrAmountStatus));
  }
  for (const ocrAmountStatus of [true, 'True', null, undefined]) {
    assert.equal(depositHoldReason({ ocrAmountStatus }), null, String(ocrAmountStatus));
  }
  for (const riskRating of ['Decline', 'decline', ' DECLINE ']) {
    assert.equal(depositHoldReason({ riskRating }), 'held_risk_decline', riskRating);
  }
  // A Warning risk rating no longer holds (Option 1).
  for (const riskRating of ['Warning', ' WARNING ', 'Accepted', 'accepted', 2, null, '']) {
    assert.equal(depositHoldReason({ riskRating }), null, String(riskRating));
  }
  // Duplicate or mismatch named in CheckAlt's status, warning, exception or error text still holds.
  assert.equal(depositHoldReason({ statusDescription: 'Possible duplicate item' }), 'held_duplicate');
  assert.equal(depositHoldReason({ warnings: ['Duplicate item detected'] }), 'held_duplicate');
  assert.equal(depositHoldReason({ exceptions: [{ message: 'Amount mismatch' }] }), 'held_amount_mismatch');
  assert.equal(depositHoldReason({ errors: [{ code: 4, message: 'CAR/LAR mismatch' }] }), 'held_amount_mismatch');
  // Order: the structured duplicate flag wins over an amount flag.
  assert.equal(depositHoldReason({ duplicateStatus: true, ocrAmountStatus: false }), 'held_duplicate');
  assert.equal(depositHoldReason(null), null);
});

test('depositHoldReason: Check Alt Review All ("0: Validation Failure"), warnings, errors, exceptions, risk factors and other words no longer hold', () => {
  for (const statusDescription of ['Pending', 'Pending Approval', 'Validation Failure', '0: Validation Failure',
    'Item on hold for review', 'Risk review', 'Exception', 'Warning', 'Suspect', 'Unreadable', 'Fraud check']) {
    assert.equal(depositHoldReason({ status: 40, statusDescription }), null, statusDescription);
  }
  assert.equal(depositHoldReason({ status: 40, reasonCode: 0, reasonDescription: 'Validation Failure', warnings: ['Review All'], errors: [{ code: 0, message: 'Validation Failure' }] }), null);
  for (const key of ['exceptions', 'warnings', 'riskFactors', 'errors']) {
    assert.equal(depositHoldReason({ [key]: ['x'] }), null, key);
  }
  // riskRatingDescription is free text and never decides on its own.
  for (const riskRatingDescription of ['High Risk', 'Medium Risk', 'Risk review', 'duplicate', '']) {
    assert.equal(depositHoldReason({ riskRatingDescription }), null, riskRatingDescription);
  }
});

test('depositIsFlagged is depositHoldReason !== null', () => {
  for (const json of [{ duplicateStatus: true }, { ocrAmountStatus: false }, { riskRating: 'Decline' }, { warnings: ['x'] }, { statusDescription: '0: Validation Failure' }, null]) {
    assert.equal(depositIsFlagged(json), depositHoldReason(json) !== null, JSON.stringify(json));
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
  assert.equal(text('held_duplicate'), 'Check Alt reported a possible duplicate');
  assert.equal(text('held_amount_mismatch'), 'Check Alt reported an amount mismatch');
  assert.equal(text('held_ocr_amount_mismatch'), 'The amount Check Alt read does not match the entered amount');
  assert.equal(text('held_risk_decline'), 'Check Alt rated this check Decline');
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
