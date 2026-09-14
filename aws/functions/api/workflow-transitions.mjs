/**
 * Explicit ChecksOps status/stage machine for AWS Tranche 5.
 * Aligned with production submit_check_review_decision() from-states
 * (supabase/migrations/20260527170437_*.sql). Does not invent new
 * business statuses. Provider/money destinations stay denied.
 */

export const INTERNAL_CREATE_STATUS = 'uploaded';
export const INTERNAL_CREATE_STAGE = 'review';
export const READY_STATUS = 'approved_for_deposit';
export const READY_STAGE = 'ready_for_deposit';

/** Destinations that would execute deposit / provider / money movement. */
export const PROVIDER_OR_FINANCIAL_ACTIONS = new Set([
  'mark_deposited',
  'deposit_action',
  'branch_deposit_required',
  'submit_checkalt',
  'checkalt_submit_deposit',
  'moov_transfer',
  'disburse',
  'funds_released',
  'disbursed_externally',
]);

export const TRANSITIONS = {
  start_review: {
    action: 'start_review',
    fromStatus: ['uploaded'],
    toStatus: 'needs_review',
    toStage: 'review',
    requiredRole: 'tenant_member',
    financialAuthorization: false,
    providerExecution: false,
    requiredRecords: [],
    notes: 'Internal review entry. Production OCR normally advances uploaded → review; AWS skips OCR.',
  },
  start_endorsing: {
    action: 'start_endorsing',
    fromStatus: ['uploaded', 'needs_review', 'ocr_complete', 'manual_review_required'],
    toStatus: 'endorsements_in_progress',
    toStage: 'endorsing',
    requiredRole: 'staff_or_tenant_admin',
    financialAuthorization: false,
    providerExecution: false,
    requiredRecords: [],
    notes: 'Internal endorsing stage only. Does not send signature email or mark signed.',
  },
  route_loss_draft: {
    action: 'route_loss_draft',
    fromStatus: [
      'needs_review',
      'manual_review_required',
      'endorsements_complete',
      'ocr_complete',
      'endorsements_in_progress',
      'approved_for_deposit',
      'branch_deposit_required',
    ],
    toStatus: 'loss_draft_required',
    toStage: 'loss_draft',
    requiredRole: 'staff_or_tenant_admin',
    financialAuthorization: false,
    providerExecution: false,
    requiredRecords: [],
    notes: 'DB trigger trg_auto_create_loss_draft may insert an internal tracking row. No mortgage-desk email.',
  },
  mark_ready_for_deposit: {
    action: 'mark_ready_for_deposit',
    fromStatus: [
      'needs_review',
      'manual_review_required',
      'endorsements_complete',
      'endorsements_in_progress',
      'loss_draft_required',
      'branch_deposit_required',
    ],
    toStatus: READY_STATUS,
    toStage: READY_STAGE,
    requiredRole: 'staff_or_tenant_admin',
    financialAuthorization: false,
    providerExecution: false,
    requiredRecords: ['endorsement_complete'],
    notes: 'READY FOR PROVIDER EXECUTION. Requires completed endorsements. endorsements_in_progress is allowed as a manual Review backup after AWS send sets that status. Does not submit CheckAlt or move money. Production CheckAlt submit re-checks endorsements independently.',
  },
  return_to_review: {
    action: 'return_to_review',
    fromStatus: [
      'uploaded',
      'needs_review',
      'endorsements_in_progress',
      'approved_for_deposit',
      'loss_draft_required',
      'branch_deposit_required',
      'reissue_requested',
    ],
    toStatus: 'needs_review',
    toStage: 'review',
    requiredRole: 'staff_or_tenant_admin',
    financialAuthorization: false,
    providerExecution: false,
    requiredRecords: [],
    notes: 'Revert an internal decision. Does not undo provider submissions (none occur in T5).',
  },
};

export const REVIEW_PATH_TO_ACTION = {
  endorsements_in_progress: 'start_endorsing',
  loss_draft_required: 'route_loss_draft',
  approved_for_deposit: 'mark_ready_for_deposit',
  revert_to_review: 'return_to_review',
  hold_for_claim_review: 'return_to_review',
};

export const DENIED_REVIEW_PATHS = {
  branch_deposit_required: 'financial_or_provider',
  reissue_requested: 'not_in_tranche_5_machine',
  merge_only: 'not_in_tranche_5_machine',
  deposited: 'financial_or_provider',
};

const PARTNER_ORIGINS = new Set(['freedom_crm']);

export const isPartnerLinked = (check = {}) => {
  const origin = check.external_origin && typeof check.external_origin === 'object'
    ? check.external_origin
    : {};
  if (PARTNER_ORIGINS.has(String(origin.source_app || ''))) return true;
  if (origin.source_check_id) return true;
  return false;
};

export const isTerminalFinancial = (check = {}) => {
  const status = String(check.status || '');
  const stage = String(check.check_stage || '');
  return status === 'deposited'
    || ['deposited', 'funds_released', 'disbursed_externally'].includes(stage)
    || Boolean(check.deposited_at);
};

export const evaluateTransition = (action, check = {}) => {
  if (PROVIDER_OR_FINANCIAL_ACTIONS.has(action)) {
    return {
      ok: false,
      error: 'financial_or_provider',
      message: 'This transition would execute a deposit, disbursement, or provider call. T5 stops before provider execution.',
    };
  }
  const spec = TRANSITIONS[action];
  if (!spec) {
    return { ok: false, error: 'unknown_transition', message: `Unknown workflow action: ${action}` };
  }
  if (!check?.id) {
    return { ok: false, error: 'rls_denied', message: 'check not found or not writable' };
  }
  if (check.claim_id) {
    return {
      ok: false,
      error: 'claim_linked_transition_denied',
      message: 'T5 will not change status on a claim-linked check because homeowner-ledger triggers write amounts.',
    };
  }
  if (isPartnerLinked(check)) {
    return {
      ok: false,
      error: 'partner_linked_transition_denied',
      message: 'T5 will not change status on a partner-mirrored check (notify_freedom_status_change can HTTP to Freedom).',
    };
  }
  if (isTerminalFinancial(check)) {
    return {
      ok: false,
      error: 'financial_or_provider',
      message: 'Deposited or released checks cannot be transitioned on AWS staging.',
    };
  }
  const from = String(check.status || '');
  if (!spec.fromStatus.includes(from)) {
    return {
      ok: false,
      error: 'invalid_transition',
      message: `Invalid status transition: ${from || 'null'} → ${spec.toStatus}`,
      fromStatus: from || null,
      toStatus: spec.toStatus,
      allowedFrom: spec.fromStatus,
    };
  }
  return {
    ok: true,
    spec,
    nextStatus: spec.toStatus,
    nextStage: spec.toStage,
    readyForProviderExecution: spec.toStatus === READY_STATUS,
    providerExecution: false,
    financialAuthorization: false,
  };
};

export const mapReviewPath = (depositPath) => {
  const path = String(depositPath || '').trim();
  if (!path) return { error: 'missing_required_field', field: 'action' };
  if (DENIED_REVIEW_PATHS[path]) {
    return {
      error: DENIED_REVIEW_PATHS[path],
      message: `Review path ${path} is not an allowed T5 internal transition`,
      depositPath: path,
    };
  }
  if (PROVIDER_OR_FINANCIAL_ACTIONS.has(path)) {
    return { error: 'financial_or_provider', depositPath: path };
  }
  const action = REVIEW_PATH_TO_ACTION[path] || (TRANSITIONS[path] ? path : null);
  if (!action) return { error: 'unknown_transition', depositPath: path };
  return { action };
};
