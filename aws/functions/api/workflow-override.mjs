/**
 * Single admin override path used by POST /workflow/override and
 * admin_override_check_status RPC. Does not invoke providers or money movement.
 */
import {
  ADMIN_OVERRIDE_STATUSES,
  inconsistentPairReason,
  stageForStatus,
} from './check-status-stage.mjs';
import { isMasterOwner } from './platform-authz.mjs';
import { applyReverseTransitionCleanup } from './workflow-cleanup.mjs';
import { USER_ROLES_SQL } from './identity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const canAdminOverrideCheck = async (client, { userId, tenantId }) => {
  if (await isMasterOwner(client)) return { ok: true, via: 'is_master_owner' };
  const roles = (await client.query(USER_ROLES_SQL, [userId])).rows
    .map((row) => String(row.role || '').toLowerCase());
  if (roles.includes('admin')) return { ok: true, via: 'app_role_admin' };
  if (roles.includes('staff') && tenantId) {
    const member = (await client.query(
      `SELECT 1 FROM public.tenant_users
       WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [userId, tenantId],
    )).rows[0];
    if (member) return { ok: true, via: 'staff_tenant_member' };
  }
  const tenantRole = tenantId
    ? (await client.query(
      `SELECT role FROM public.tenant_users
       WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [userId, tenantId],
    )).rows[0]?.role
    : null;
  if (['admin', 'owner'].includes(String(tenantRole || '').toLowerCase())) {
    return { ok: true, via: 'tenant_admin' };
  }
  return { ok: false, error: 'not_authorized' };
};

export const evaluateAdminOverride = ({ current = {}, destinationStatus, reason } = {}) => {
  const nextStatus = String(destinationStatus || '').trim();
  const trimmedReason = String(reason || '').trim();
  if (!ADMIN_OVERRIDE_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      error: 'invalid_destination',
      message: 'Destination is not a permitted operational override status',
      allowed: [...ADMIN_OVERRIDE_STATUSES],
    };
  }
  if (trimmedReason.length < 5) {
    return { ok: false, error: 'reason_required', message: 'Override requires a reason' };
  }
  if (current?.deposited_at || ['deposited', 'funds_released', 'disbursed_externally'].includes(String(current.check_stage || ''))) {
    return {
      ok: false,
      error: 'financial_or_provider',
      message: 'Deposited or released checks cannot be overridden without a financial workflow',
    };
  }
  if (String(current.status || '') === 'deposited') {
    return {
      ok: false,
      error: 'financial_or_provider',
      message: 'Deposited checks cannot be overridden through this operational path',
    };
  }
  const nextStage = stageForStatus(nextStatus);
  const pairError = inconsistentPairReason(nextStatus, nextStage);
  if (pairError) {
    return { ok: false, error: 'invalid_status_stage_pair', message: pairError };
  }
  return {
    ok: true,
    nextStatus,
    nextStage,
    reason: trimmedReason,
    providerExecution: false,
    financialAuthorization: false,
  };
};

export const executeAdminOverride = async (client, {
  check,
  mapping,
  destinationStatus,
  reason,
} = {}) => {
  const decided = evaluateAdminOverride({
    current: check,
    destinationStatus,
    reason,
  });
  if (!decided.ok) return decided;

  const authz = await canAdminOverrideCheck(client, {
    userId: mapping.application_user_id,
    tenantId: check.tenant_id,
  });
  if (!authz.ok) return { ...authz, statusCode: 403 };

  const previousStatus = check.status;
  const previousStage = check.check_stage;
  const rows = (await client.query(
    `UPDATE public.check_intake_items
     SET status = $2::text,
         check_stage = $3::check_stage,
         review_notes = COALESCE($4::text, review_notes),
         updated_at = now()
     WHERE id = $1::uuid
       AND deposited_at IS NULL
     RETURNING *`,
    [check.id, decided.nextStatus, decided.nextStage, decided.reason],
  )).rows;
  if (!rows.length) {
    return { ok: false, error: 'rls_denied', message: 'check not writable' };
  }

  await applyReverseTransitionCleanup(client, {
    checkId: check.id,
    action: 'admin_override',
    fromStatus: previousStatus,
    fromStage: previousStage,
    toStatus: decided.nextStatus,
    toStage: decided.nextStage,
    actorId: mapping.application_user_id,
  });

  await client.query(
    `UPDATE public.claim_checks
     SET check_stage = $2::check_stage, updated_at = now()
     WHERE check_intake_item_id = $1::uuid`,
    [check.id, decided.nextStage],
  ).catch(() => {});

  const audit = (await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'status_manual_override', $4::text, $5::jsonb
     ) RETURNING id, created_at`,
    [
      check.id,
      check.tenant_id,
      mapping.application_user_id,
      `Admin override ${previousStatus} → ${decided.nextStatus}: ${decided.reason}`,
      JSON.stringify({
        old_status: previousStatus,
        new_status: decided.nextStatus,
        old_stage: previousStage,
        new_stage: decided.nextStage,
        reason: decided.reason,
        actor_id: mapping.application_user_id,
        provider_execution: false,
        financial_authorization: false,
        authorization: authz.via,
      }),
    ],
  )).rows[0];

  return {
    ok: true,
    data: {
      ok: true,
      check_id: check.id,
      old_status: previousStatus,
      new_status: decided.nextStatus,
      old_stage: previousStage,
      new_stage: decided.nextStage,
      reason: decided.reason,
      actor_id: mapping.application_user_id,
      timestamp: audit?.created_at || new Date().toISOString(),
      audit_id: audit?.id || null,
      providerExecution: false,
    },
  };
};

export const isOverrideUuid = (value) => UUID_RE.test(String(value || ''));
