/**
 * AWS staging bridge for admin_override_check_status.
 *
 * Replicates the production SECURITY DEFINER function without GRANT EXECUTE
 * and without provider or money-movement side effects. Same-company
 * tenant_users members may move a check to any non-deposit status,
 * including backwards to Review.
 */
import { canMoveTenantChecks } from './tenant-check-user.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const arg = (args, ...keys) => {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) return args[key];
  }
  return null;
};

/** Production-allowed statuses minus deposited (that destination is money movement). */
export const ADMIN_OVERRIDE_ALLOWED_STATUSES = new Set([
  'uploaded',
  'processing',
  'ocr_complete',
  'needs_review',
  'manual_review_required',
  'reissue_requested',
  'endorsements_in_progress',
  'endorsements_complete',
  'approved_for_deposit',
  'branch_deposit_required',
  'loss_draft_required',
  'voided',
]);

export const stageForAdminOverrideStatus = (status) => {
  switch (status) {
    case 'endorsements_in_progress':
    case 'endorsements_complete':
      return 'endorsing';
    case 'approved_for_deposit':
    case 'branch_deposit_required':
      return 'ready_for_deposit';
    case 'loss_draft_required':
      return 'loss_draft';
    default:
      return 'review';
  }
};

export const recommendationForAdminOverrideStatus = (status) => {
  switch (status) {
    case 'endorsements_in_progress':
    case 'endorsements_complete':
      return 'endorsements_pending';
    case 'approved_for_deposit':
      return 'ready_for_deposit';
    case 'branch_deposit_required':
      return 'branch_deposit_recommended';
    case 'loss_draft_required':
      return 'loss_draft_required';
    case 'reissue_requested':
      return 'request_reissue';
    default:
      return null;
  }
};

export const executeAdminOverrideCheckStatus = async ({ client, mapping, args }) => {
  const checkId = arg(args, 'p_check_id', 'check_id');
  const newStatus = String(arg(args, 'p_new_status', 'new_status') || '').trim();
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
  if (!newStatus) return { error: 'missing_required_field', field: 'p_new_status' };
  if (newStatus === 'deposited') {
    return {
      error: 'rpc_financial_disabled',
      message: "admin_override_check_status to 'deposited' remains disabled (money movement)",
      status: newStatus,
    };
  }
  if (!ADMIN_OVERRIDE_ALLOWED_STATUSES.has(newStatus)) {
    return { error: 'invalid_status', message: `Invalid status: ${newStatus}`, status: newStatus };
  }

  const check = (await client.query(
    `SELECT id, tenant_id, status, check_stage::text AS check_stage
     FROM public.check_intake_items
     WHERE id = $1::uuid
     FOR UPDATE`,
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'Check not found' };

  const member = check.tenant_id
    ? (await client.query(
      `SELECT 1 FROM public.tenant_users
       WHERE user_id = $1::uuid AND tenant_id = $2::uuid
       LIMIT 1`,
      [mapping.application_user_id, check.tenant_id],
    )).rows[0]
    : null;
  if (!canMoveTenantChecks({ isTenantMember: !!member })) {
    return { error: 'not_authorized', message: 'Not permitted to override this check' };
  }

  // Persist through the SECURITY DEFINER RPC so intake + claim_checks + audit
  // write as the function owner. Staging checksops has no table UPDATE on
  // claim_checks.check_stage; GRANT/REVOKE is out of scope for #601.
  const invoked = await client.query(
    `SELECT public.admin_override_check_status($1::uuid, $2::text, $3::uuid) AS result`,
    [checkId, newStatus, mapping.application_user_id],
  );
  const payload = invoked.rows[0]?.result;
  if (!payload || payload.ok !== true) {
    return { error: 'rls_denied', message: 'admin_override_check_status did not persist' };
  }
  return { data: payload };
};
