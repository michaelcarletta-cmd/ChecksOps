import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideAutoApprove,
  depositIsFlagged,
  isCheckAltApproveLockError,
  resolveAutoApprovePolicy,
  riskIsLow,
  safeCheckAltReference,
} from '../functions/api/providers/production/checkalt-submit.mjs';

const clean = {
  processRequiresApproval: true,
  reference: '9001',
  enabled: true,
  maxCents: 200000,
  amountCents: 154672,
  flagged: false,
  riskLow: true,
};

test('decideAutoApprove: approves only clean, enabled, referenced, at-or-under-ceiling deposits', () => {
  assert.deepEqual(decideAutoApprove(clean), { approve: true, skipReason: null });
  assert.equal(decideAutoApprove({ ...clean, amountCents: 200000 }).approve, true);
  const skip = (over) => decideAutoApprove({ ...clean, ...over }).skipReason;
  assert.equal(skip({ amountCents: 200001 }), 'over_max_amount');
  assert.equal(skip({ maxCents: null }), 'missing_auto_approve_ceiling');
  assert.equal(skip({ maxCents: 1999.5 }), 'missing_auto_approve_ceiling');
  assert.equal(skip({ enabled: false }), 'auto_approve_disabled');
  assert.equal(skip({ enabled: 'true' }), 'auto_approve_disabled');
  assert.equal(skip({ flagged: true }), 'flagged_by_checkalt');
  assert.equal(skip({ reference: null }), 'missing_reference');
  assert.equal(skip({ processRequiresApproval: false }), 'not_pending_approval');
  assert.equal(skip({ riskLow: false }), 'risk_not_low');
  assert.equal(decideAutoApprove({ ...clean, riskLow: undefined }).skipReason, 'risk_not_low');
  assert.equal(skip({ reference: 'abc' }), 'invalid_reference');
  assert.equal(skip({ reference: '0' }), 'invalid_reference');
  assert.equal(skip({ reference: '99999999999999999999' }), 'invalid_reference');
  assert.equal(skip({ reference: 9001 }), null);
  assert.equal(skip({ amountCents: 0 }), 'invalid_amount');
  assert.equal(skip({ amountCents: 12.5 }), 'invalid_amount');
});

test('resolveAutoApprovePolicy: tenant row wins; blank tenant ceiling does not fall back to global', () => {
  const globalCfg = { auto_approve_enabled: true, auto_approve_max_cents: 500000 };
  assert.deepEqual(
    resolveAutoApprovePolicy({ auto_approve_enabled: true, auto_approve_max_cents: 200000 }, globalCfg),
    { enabled: true, maxCents: 200000, source: 'checkalt_tenant_accounts' },
  );
  assert.deepEqual(
    resolveAutoApprovePolicy({ auto_approve_enabled: true, auto_approve_max_cents: null }, globalCfg),
    { enabled: true, maxCents: null, source: 'checkalt_tenant_accounts' },
  );
  assert.equal(resolveAutoApprovePolicy({ auto_approve_enabled: false, auto_approve_max_cents: 200000 }, globalCfg).enabled, false);
  assert.deepEqual(resolveAutoApprovePolicy(null, globalCfg), { enabled: true, maxCents: 500000, source: 'checkalt_config' });
  assert.deepEqual(resolveAutoApprovePolicy(null, null), { enabled: false, maxCents: null, source: 'none' });
  assert.equal(resolveAutoApprovePolicy({ auto_approve_enabled: true, auto_approve_max_cents: '' }).maxCents, null);
  assert.equal(resolveAutoApprovePolicy({ auto_approve_enabled: true, auto_approve_max_cents: -1 }).maxCents, null);
});

test('depositIsFlagged: CheckAlt flags block; clean riskRating keys do not', () => {
  assert.equal(depositIsFlagged({
    status: 40, statusDescription: 'Pending Approval', riskRating: 2, riskRatingDescription: 'Low Risk', errors: [],
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

test('isCheckAltApproveLockError: only 404 locate/locked retries', () => {
  assert.equal(isCheckAltApproveLockError(404, { message: 'Unable to locate transaction' }), true);
  assert.equal(isCheckAltApproveLockError(404, { statusDescription: 'Item locked' }), true);
  assert.equal(isCheckAltApproveLockError(404, { message: 'not found' }), false);
  assert.equal(isCheckAltApproveLockError(500, { message: 'locked' }), false);
});

test('riskIsLow: only a trimmed, case-insensitive "Low Risk" is clean', () => {
  assert.equal(riskIsLow({ riskRatingDescription: 'Low Risk' }), true);
  assert.equal(riskIsLow({ riskRatingDescription: '  low risk ' }), true);
  assert.equal(riskIsLow({ riskRatingDescription: 'High Risk' }), false);
  assert.equal(riskIsLow({ riskRatingDescription: 'Medium Risk' }), false);
  assert.equal(riskIsLow({ riskRatingDescription: 'Low Risk - review' }), false);
  assert.equal(riskIsLow({ riskRatingDescription: '' }), false);
  assert.equal(riskIsLow({ riskRating: 1 }), false);
  assert.equal(riskIsLow(null), false);
});

test('safeCheckAltReference: positive safe integers only', () => {
  assert.equal(safeCheckAltReference('123733567'), 123733567);
  assert.equal(safeCheckAltReference(9001), 9001);
  for (const bad of [null, undefined, '', '0', '-1', '1.5', '1e5', 'abc', '9007199254740993']) {
    assert.equal(safeCheckAltReference(bad), null, String(bad));
  }
});
