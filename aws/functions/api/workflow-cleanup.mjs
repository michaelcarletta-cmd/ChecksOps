/**
 * Reverse-transition operational cleanup. Historical audit rows are retained.
 */
export const LOSS_DRAFT_OPERATIONAL_CLOSE_STATUS = 'endorsing';

export const shouldCloseLossDraftTracking = ({ fromStatus, fromStage, toStatus, toStage } = {}) => {
  const leavingLossDraft = fromStatus === 'loss_draft_required' || fromStage === 'loss_draft';
  const stayingLossDraft = toStatus === 'loss_draft_required' || toStage === 'loss_draft';
  return leavingLossDraft && !stayingLossDraft;
};

export const cleanupLossDraftTrackingSql = `
UPDATE public.loss_draft_tracking
SET escrow_status = $2::text,
    notes = CASE
      WHEN notes IS NULL OR notes = '' THEN $3::text
      ELSE notes || E'\\n' || $3::text
    END,
    updated_at = now()
WHERE check_intake_item_id = $1::uuid
  AND escrow_status IS DISTINCT FROM 'final_release_complete'
  AND escrow_status IS DISTINCT FROM $2::text
RETURNING id
`;

export const describeReverseCleanup = ({ action, fromStatus, fromStage, toStatus, toStage } = {}) => {
  const ops = [];
  if (shouldCloseLossDraftTracking({ fromStatus, fromStage, toStatus, toStage })) {
    ops.push({
      artifact: 'loss_draft_tracking',
      retention: 'keep_row_and_audit',
      operational: `set escrow_status=${LOSS_DRAFT_OPERATIONAL_CLOSE_STATUS} so Loss Draft queues no longer classify this check`,
    });
  }
  if ((fromStage === 'endorsing' || fromStatus === 'endorsements_in_progress')
    && toStage !== 'endorsing' && toStatus !== 'endorsements_in_progress') {
    ops.push({
      artifact: 'check_payees/check_endorsements',
      retention: 'keep',
      operational: 'payee and endorsement records stay; stage no longer endorsing',
    });
  }
  if ((fromStage === 'ready_for_deposit' || fromStatus === 'approved_for_deposit')
    && toStage !== 'ready_for_deposit' && toStatus !== 'approved_for_deposit') {
    ops.push({
      artifact: 'deposit_recommendation',
      retention: 'keep',
      operational: 'recommendation history stays; destination stage/status become source of truth',
    });
  }
  if ((fromStatus === 'reissue_requested' || fromStage === 'reissue')
    && toStatus !== 'reissue_requested') {
    ops.push({
      artifact: 'reissue_status',
      retention: 'keep_audit',
      operational: 'reissue flag is the status itself; leaving it is the cleanup',
    });
  }
  if (!ops.length) {
    ops.push({
      artifact: 'check_intake_items',
      retention: 'keep_audit',
      operational: 'status/stage update only; related payee, endorsement, and audit rows are retained',
    });
  }
  return {
    action: action || null,
    fromStatus: fromStatus || null,
    fromStage: fromStage || null,
    toStatus: toStatus || null,
    toStage: toStage || null,
    deletedAudit: false,
    operations: ops,
  };
};

export const applyReverseTransitionCleanup = async (client, {
  checkId,
  action,
  fromStatus,
  fromStage,
  toStatus,
  toStage,
  actorId,
} = {}) => {
  const plan = describeReverseCleanup({ action, fromStatus, fromStage, toStatus, toStage });
  const closed = [];
  if (shouldCloseLossDraftTracking({ fromStatus, fromStage, toStatus, toStage })) {
    const note = `workflow_cleanup ${action || 'transition'}: operational loss-draft closed (${fromStatus} → ${toStatus})`;
    const rows = (await client.query(cleanupLossDraftTrackingSql, [
      checkId,
      LOSS_DRAFT_OPERATIONAL_CLOSE_STATUS,
      note,
    ])).rows;
    closed.push(...rows.map((row) => row.id));
    if (rows.length) {
      await client.query(
        `INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, notes, old_values, new_values)
         SELECT id, 'workflow_reverse_cleanup', $2::uuid, $3::text, $4::jsonb, $5::jsonb
         FROM public.loss_draft_tracking
         WHERE id = ANY($1::uuid[])`,
        [
          closed,
          actorId || null,
          note,
          JSON.stringify({ escrow_status: fromStatus, check_stage: fromStage }),
          JSON.stringify({
            escrow_status: LOSS_DRAFT_OPERATIONAL_CLOSE_STATUS,
            check_id: checkId,
            to_status: toStatus,
            to_stage: toStage,
            historical_row_retained: true,
          }),
        ],
      ).catch(() => {
        /* operational close still applies if audit insert is denied */
      });
    }
  }
  return { ...plan, closedTrackingIds: closed };
};
