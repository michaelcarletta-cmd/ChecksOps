/**
 * Canonical status ↔ check_stage pairs and admin-override destinations.
 * Shared by the AWS workflow engine so there is one status machine.
 */

export const CHECK_STAGES = Object.freeze([
  'review',
  'loss_draft',
  'endorsing',
  'ready_for_deposit',
  'deposited',
  'funds_released',
  'disbursed_externally',
]);

/** Operational statuses an admin may override to. Deposited / funds movement excluded. */
export const ADMIN_OVERRIDE_STATUSES = Object.freeze([
  'needs_review',
  'endorsements_in_progress',
  'approved_for_deposit',
  'loss_draft_required',
  'reissue_requested',
  'voided',
]);

/** status → required check_stage. Unknown statuses are not auto-rewritten. */
export const STATUS_TO_STAGE = Object.freeze({
  uploaded: 'review',
  processing: 'review',
  ocr_complete: 'review',
  needs_review: 'review',
  manual_review_required: 'review',
  endorsements_complete: 'endorsing',
  endorsements_in_progress: 'endorsing',
  approved_for_deposit: 'ready_for_deposit',
  branch_deposit_required: 'ready_for_deposit',
  loss_draft_required: 'loss_draft',
  reissue_requested: 'review',
  voided: 'review',
  deposited: 'deposited',
  funds_released: 'funds_released',
  disbursed_externally: 'disbursed_externally',
});

export const IMPOSSIBLE_STATUS_STAGE_PAIRS = Object.freeze([
  { status: 'deposited', check_stage: 'ready_for_deposit' },
  { status: 'deposited', check_stage: 'review' },
  { status: 'deposited', check_stage: 'endorsing' },
  { status: 'deposited', check_stage: 'loss_draft' },
  { status: 'needs_review', check_stage: 'deposited' },
  { status: 'endorsements_in_progress', check_stage: 'deposited' },
  { status: 'approved_for_deposit', check_stage: 'deposited' },
  { status: 'loss_draft_required', check_stage: 'deposited' },
  { status: 'loss_draft_required', check_stage: 'endorsing' },
  { status: 'loss_draft_required', check_stage: 'ready_for_deposit' },
  { status: 'endorsements_in_progress', check_stage: 'loss_draft' },
  { status: 'approved_for_deposit', check_stage: 'loss_draft' },
  { status: 'needs_review', check_stage: 'endorsing' },
  { status: 'needs_review', check_stage: 'loss_draft' },
]);

export const stageForStatus = (status) => {
  const key = String(status || '').trim();
  return STATUS_TO_STAGE[key] || null;
};

export const isAllowedStatusStagePair = (status, checkStage) => {
  const expected = stageForStatus(status);
  if (!expected) return false;
  return String(checkStage || '') === expected;
};

export const inconsistentPairReason = (status, checkStage) => {
  if (isAllowedStatusStagePair(status, checkStage)) return null;
  const expected = stageForStatus(status);
  if (!expected) {
    return `unknown status "${status || 'null'}" has no canonical check_stage`;
  }
  return `status "${status}" requires check_stage "${expected}", found "${checkStage || 'null'}"`;
};

export const INCONSISTENT_STATUS_STAGE_SQL = `
SELECT c.id::text AS id,
       c.tenant_id::text AS tenant_id,
       c.status,
       c.check_stage::text AS check_stage,
       c.deposited_at
FROM public.check_intake_items c
WHERE (
  (c.status = 'deposited' AND c.check_stage IS DISTINCT FROM 'deposited')
  OR (c.status = 'loss_draft_required' AND c.check_stage IS DISTINCT FROM 'loss_draft')
  OR (c.status = 'endorsements_in_progress' AND c.check_stage IS DISTINCT FROM 'endorsing')
  OR (c.status = 'approved_for_deposit' AND c.check_stage IS DISTINCT FROM 'ready_for_deposit')
  OR (c.status IN ('needs_review', 'manual_review_required', 'uploaded', 'ocr_complete', 'reissue_requested', 'voided')
      AND c.check_stage IS DISTINCT FROM 'review')
)
ORDER BY c.updated_at DESC NULLS LAST
LIMIT 200
`;
