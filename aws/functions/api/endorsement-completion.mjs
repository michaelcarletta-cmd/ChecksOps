/**
 * Shared endorsement-completion math (AWS + tests).
 * Mortgage company + manual_required is satisfied for ENDORSEMENT MATH only.
 * Contractor rows are CC-only and are not required signers.
 * Active Loss Draft must never be released to Ready by this math.
 */

export const isContractorPayee = (payeeType) => String(payeeType || '').toLowerCase() === 'contractor';

export const payeeTypeOf = (row = {}) => String(row.payee_type || '').toLowerCase();

export const isEndorsementSatisfied = (row = {}) => {
  const type = payeeTypeOf(row);
  if (type === 'contractor') return true;
  const status = String(row.status || '');
  if (status === 'signed' || status === 'waived') return true;
  if (type === 'mortgage_company' && status === 'manual_required') return true;
  return false;
};

export const evaluateEndorsementMath = (rows = []) => {
  if (!rows.length) return { allRequiredSatisfied: false, anyRejected: false };
  const anyRejected = rows.some((row) => String(row.status || '') === 'rejected');
  return {
    allRequiredSatisfied: rows.every(isEndorsementSatisfied),
    anyRejected,
  };
};

export const isActiveLossDraft = (check = {}) => (
  String(check.status || '') === 'loss_draft_required'
  || String(check.check_stage || '') === 'loss_draft'
);

export const decideReadyTransition = (check = {}, evaluation = {}) => {
  if (evaluation.anyRejected) return { action: 'return_to_review' };
  if (!evaluation.allRequiredSatisfied) return { action: 'none' };
  if (isActiveLossDraft(check)) return { action: 'hold_loss_draft' };
  if (
    String(check.status || '') === 'approved_for_deposit'
    && String(check.deposit_recommendation || '') === 'ready_for_deposit'
  ) {
    return { action: 'already_ready' };
  }
  if (String(check.deposit_recommendation || '') === 'branch_deposit_recommended') {
    return { action: 'branch_ready' };
  }
  return { action: 'ready' };
};
