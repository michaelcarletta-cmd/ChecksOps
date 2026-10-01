/**
 * Dedicated AWS administrative status-correction path.
 *
 * Distinct from POST /workflow/transition (normal state machine).
 * Mirrors historical public.admin_override_check_status semantics:
 * authorized admins/platform owners may set an explicit target status
 * even when the ordinary machine would refuse the jump.
 *
 * Does not GRANT the production DEFINER RPC and is not on SAFE_WRITE_RPCS.
 */
import { ignoredSpoof, IS_PLATFORM_OWNER_SQL, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master';
const ADMIN_ROLES = new Set(['admin', 'owner']);

/** Historical allowed targets minus `deposited` (money-path destination). */
export const ADMIN_STATUS_CORRECTION_STATUSES = new Set([
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

export const ADMIN_STATUS_STAGE = {
  endorsements_in_progress: 'endorsing',
  endorsements_complete: 'endorsing',
  approved_for_deposit: 'ready_for_deposit',
  branch_deposit_required: 'ready_for_deposit',
  loss_draft_required: 'loss_draft',
};

export const ADMIN_STATUS_RECOMMENDATION = {
  endorsements_in_progress: 'endorsements_pending',
  endorsements_complete: 'endorsements_pending',
  approved_for_deposit: 'ready_for_deposit',
  branch_deposit_required: 'branch_deposit_recommended',
  loss_draft_required: 'loss_draft_required',
  reissue_requested: 'request_reissue',
};

export const stageForAdminStatus = (status) => ADMIN_STATUS_STAGE[status] || 'review';
export const recommendationForAdminStatus = (status) => ADMIN_STATUS_RECOMMENDATION[status] ?? null;

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  applicationWorkflowWritesEnabled: applicationWorkflowWritesEnabled(),
  providerExecution: false,
  productionSupabaseChanged: false,
  ...extra,
});

const requireWorkflowEnabled = (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceWorkflow === true || applicationWorkflowWritesEnabled();
  if (!enabled) {
    return {
      blocked: denied(spoof, {
        error: 'application_workflow_writes_disabled',
        message: 'Application-workflow writes are disabled by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
      }),
    };
  }
  return { body, spoof };
};

const lookupCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, status, check_stage, claim_id, deposited_at
     FROM public.check_intake_items
     WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'not_found', message: 'Check not found' };
  return { check: rows[0] };
};

const isPlatformOwner = async (client) => {
  const [owner, master] = await Promise.all([
    client.query(IS_PLATFORM_OWNER_SQL),
    client.query(MASTER_OWNER_SQL),
  ]);
  return owner.rows[0]?.is_owner === true || master.rows[0]?.is_master === true;
};

const platformRolesOf = async (client, userId) => {
  const rows = (await client.query(USER_ROLES_SQL, [userId])).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

const tenantRoleOf = async (client, userId, tenantId) => {
  const rows = (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

export const authorizeAdminStatusCorrection = async ({ client, userId, tenantId }) => {
  if (await isPlatformOwner(client)) {
    return { ok: true, platformOwner: true };
  }
  const [platformRoles, tenantRoles] = await Promise.all([
    platformRolesOf(client, userId),
    tenantRoleOf(client, userId, tenantId),
  ]);
  const member = tenantRoles.size > 0;
  if (!member) {
    return { error: 'cross_tenant', message: 'Cross-tenant status correction is rejected' };
  }
  const admin = [...ADMIN_ROLES].some((role) => platformRoles.has(role) || tenantRoles.has(role));
  if (!admin) {
    return { error: 'not_authorized', message: 'Admin or platform owner required for status correction' };
  }
  return { ok: true, platformOwner: false };
};

export const handleAdminStatusCorrection = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const newStatus = String(body.new_status || body.p_new_status || body.status || '').trim();
    const reasonRaw = body.reason || body.p_reason || null;
    const reason = reasonRaw == null || reasonRaw === '' ? null : String(reasonRaw).slice(0, 2000);

    const looked = await lookupCheck(client, checkId);
    if (looked.error === 'invalid_uuid') {
      return denied(spoof, { statusCode: 400, ...looked });
    }
    if (looked.error === 'not_found') {
      return denied(spoof, { statusCode: 404, ...looked });
    }

    if (!newStatus || !ADMIN_STATUS_CORRECTION_STATUSES.has(newStatus)) {
      return denied(spoof, {
        statusCode: 400,
        error: 'invalid_status',
        message: `Invalid status: ${newStatus || '(empty)'}`,
        new_status: newStatus || null,
      });
    }

    if (looked.check.deposited_at) {
      return denied(spoof, {
        error: 'financial_lock',
        message: 'Deposited checks cannot be administratively reclassified on this path',
      });
    }

    const authz = await authorizeAdminStatusCorrection({
      client,
      userId: mapping.application_user_id,
      tenantId: looked.check.tenant_id,
    });
    if (authz.error) {
      return denied(spoof, { statusCode: 403, ...authz });
    }

    const previousStatus = looked.check.status;
    const nextStage = stageForAdminStatus(newStatus);
    const nextRecommendation = recommendationForAdminStatus(newStatus);
    const actorId = mapping.application_user_id;
    const correctedAt = new Date().toISOString();

    if (previousStatus === newStatus) {
      return {
        ok: true,
        statusCode: 200,
        data: {
          ok: true,
          check_id: looked.check.id,
          old_status: previousStatus,
          previous_status: previousStatus,
          new_status: newStatus,
          new_stage: looked.check.check_stage,
          actor_id: actorId,
          timestamp: correctedAt,
          unchanged: true,
        },
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        spoofFieldsIgnored: spoof,
        authorizationSource: 'admin_status_correction',
        applicationWorkflowWritesEnabled: true,
        providerExecution: false,
        productionSupabaseChanged: false,
      };
    }

    const rows = (await client.query(
      `UPDATE public.check_intake_items
       SET status = $2::text,
           check_stage = $3::check_stage,
           deposit_recommendation = $4::text,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, tenant_id, status, check_stage, deposit_recommendation, updated_at`,
      [looked.check.id, newStatus, nextStage, nextRecommendation],
    )).rows;
    if (!rows.length) {
      return denied(spoof, { error: 'rls_denied', message: 'check not writable' });
    }
    const updated = rows[0];

    // Historical DEFINER RPC mirrored claim_checks.check_stage. The staging
    // application role has no table UPDATE grant, so this is best-effort and
    // must not abort the authorized intake correction transaction.
    let claimChecksMirrored = false;
    await client.query('SAVEPOINT admin_status_claim_mirror');
    try {
      await client.query(
        `UPDATE public.claim_checks
         SET check_stage = $2::public.check_stage, updated_at = now()
         WHERE check_intake_item_id = $1::uuid`,
        [looked.check.id, nextStage],
      );
      await client.query('RELEASE SAVEPOINT admin_status_claim_mirror');
      claimChecksMirrored = true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT admin_status_claim_mirror');
      const code = String(error?.code || '');
      const message = String(error?.message || error);
      if (code !== '42501' && !/permission denied for (table|relation) claim_checks/i.test(message)) {
        throw error;
      }
    }

    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'status_manual_override',
         $4::text,
         $5::jsonb
       )`,
      [
        looked.check.id,
        updated.tenant_id,
        actorId,
        `Status manually changed from "${previousStatus}" to "${newStatus}"`,
        JSON.stringify({
          old_status: previousStatus,
          previous_status: previousStatus,
          new_status: newStatus,
          new_stage: nextStage,
          reason,
          timestamp: updated.updated_at || correctedAt,
        }),
      ],
    );

    return {
      ok: true,
      statusCode: 200,
      data: {
        ok: true,
        check_id: looked.check.id,
        old_status: previousStatus,
        previous_status: previousStatus,
        new_status: updated.status,
        new_stage: updated.check_stage,
        actor_id: actorId,
        timestamp: updated.updated_at || correctedAt,
        reason,
        claim_checks_mirrored: claimChecksMirrored,
      },
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'admin_status_correction',
      applicationWorkflowWritesEnabled: true,
      providerExecution: false,
      productionSupabaseChanged: false,
    };
  }, deps);
};
