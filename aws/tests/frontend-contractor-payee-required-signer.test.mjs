// Owner 2026-11-18: a contractor who is a payee on the check must endorse it,
// like the insured. The website copy of the rule drives the "All Complete"
// badge and must agree with aws/functions/api/endorsement-completion.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideReadyTransition,
  evaluateEndorsementMath,
  isEndorsementSatisfied,
} from '../../src/lib/endorsementCompletion.ts';

test('a pending contractor payee is not satisfied', () => {
  for (const status of ['pending', 'sent', 'viewed', 'manual_required', 'rejected', '']) {
    assert.equal(isEndorsementSatisfied({ payee_type: 'contractor', status }), false, status);
  }
});

test('a signed or waived contractor payee is satisfied', () => {
  assert.equal(isEndorsementSatisfied({ payee_type: 'contractor', status: 'signed' }), true);
  assert.equal(isEndorsementSatisfied({ payee_type: 'Contractor', status: 'waived' }), true);
});

test('an unsigned contractor payee holds the check back; signing releases it', () => {
  const insured = { payee_type: 'insured', status: 'signed' };
  const held = evaluateEndorsementMath([insured, { payee_type: 'contractor', status: 'pending' }]);
  assert.equal(held.allRequiredSatisfied, false);
  assert.deepEqual(decideReadyTransition({ status: 'pending_endorsement' }, held), { action: 'none' });
  const done = evaluateEndorsementMath([insured, { payee_type: 'contractor', status: 'signed' }]);
  assert.equal(done.allRequiredSatisfied, true);
  assert.deepEqual(decideReadyTransition({ status: 'pending_endorsement' }, done), { action: 'ready' });
});

test('a check with no contractor payee is unaffected, and the mortgage exception stays', () => {
  const rows = [
    { payee_type: 'insured', status: 'signed' },
    { payee_type: 'mortgage_company', status: 'manual_required' },
  ];
  assert.equal(evaluateEndorsementMath(rows).allRequiredSatisfied, true);
});
