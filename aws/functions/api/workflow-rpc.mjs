/**
 * Safe non-financial write RPC bridges for AWS staging.
 *
 * Calls replicate SECURITY DEFINER semantics under Cognito → request.app_user_id → auth.uid(),
 * without GRANT EXECUTE on production DEFINER functions and without provider/financial side effects.
 *
 * Classification for every rpc_disabled name lives in SAFE_WRITE_RPC_CLASSIFICATION.
 */
import { ignoredSpoof, IS_PLATFORM_OWNER_SQL, parseBody, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';
import { writesEnabled } from './write-allowlist.mjs';
import { executeAdminOverrideCheckStatus } from './admin-override-check-status.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

/** Actions allowed on loss_draft_action (no amount / escrow money movement). */
export const SAFE_LOSS_DRAFT_ACTIONS = new Set([
  'set_monitoring_type',
  'mark_sent',
  'mark_received_back',
  'send_for_endorsements',
  'admin_reset_status',
]);

const SAFE_LOSS_DRAFT_RESET_STATUSES = new Set([
  'pending_send',
  'sent_to_lender',
  'received_by_lender',
  'check_received_back',
  'endorsing',
]);

/**
 * Full classification of the 42 audit rpc_disabled names for this remediation batch.
 * safe_now — implemented here (or already bridged / read allowlisted)
 * already_bridged — client redirect already existed
 * read_only — added to READ_RPCS
 * provider_dependent — must stay disabled
 * financial_sensitive — must stay disabled
 */
export const SAFE_WRITE_RPC_CLASSIFICATION = {
  submit_check_review_decision_safe: 'already_bridged',
  get_or_create_notification_preferences: 'already_bridged',
  get_tenant_users_with_profiles: 'read_only',
  is_approval_required: 'read_only',
  accept_mortgage_handling_request: 'safe_now',
  update_mortgage_handling_request_status: 'safe_now',
  log_audit: 'safe_now',
  init_loss_draft_documents: 'safe_now',
  loss_draft_set_lender: 'safe_now',
  loss_draft_action: 'safe_now_subset', // financial amount actions remain disabled
  submit_homeowner_intro_request: 'safe_now',
  register_session: 'safe_now',
  validate_session: 'safe_now',
  invalidate_session: 'safe_now',
  resolve_check_case: 'safe_now',
  admin_set_contractor_pro: 'safe_now',
  record_check_return: 'safe_now',
  resolve_check_return: 'safe_now',
  get_payment_direction_by_token: 'financial_sensitive',
  admin_override_check_status: 'safe_now',
  admin_delete_check: 'already_bridged', // client → DELETE /workflow/checks
  deposit_action: 'safe_now_subset', // money / provider-sensitive actions remain disabled
  assign_deposit_owner: 'financial_sensitive',
  bulk_deposit_closeout: 'financial_sensitive',
  bulk_resolve_deposit_exceptions: 'financial_sensitive',
  bulk_sync_deposit_accounting: 'financial_sensitive',
  mark_deposit_closeout: 'financial_sensitive',
  generate_next_deposit_action: 'financial_sensitive',
  generate_deposit_daily_digest: 'financial_sensitive',
  refresh_all_deposit_next_actions: 'financial_sensitive',
  rebalance_deposit_workload: 'financial_sensitive',
  run_deposit_escalation_check: 'financial_sensitive',
  save_deposit_manager_snapshot: 'financial_sensitive',
  resolve_deposit_exception: 'financial_sensitive',
  submit_manager_approval: 'financial_sensitive',
  review_manager_approval: 'financial_sensitive',
  backfill_check_billing_events: 'financial_sensitive',
  submit_payment_direction_by_token: 'financial_sensitive',
  decide_stakeholder_limit_request: 'financial_sensitive',
  apply_referral_code: 'financial_sensitive',
  add_partner_stakeholder_to_check: 'provider_dependent',
  ensure_partner_stakeholders: 'provider_dependent',
  save_checkalt_settings: 'safe_now',
  save_checkalt_tenant_auto_deposit: 'safe_now',
};

/** RPCs executed via POST /data/rpc write path. */
export const SAFE_WRITE_RPCS = new Set([
  'accept_mortgage_handling_request',
  'update_mortgage_handling_request_status',
  'log_audit',
  'init_loss_draft_documents',
  'loss_draft_set_lender',
  'loss_draft_action',
  'submit_homeowner_intro_request',
  'register_session',
  'validate_session',
  'invalidate_session',
  'resolve_check_case',
  'admin_set_contractor_pro',
  'record_check_return',
  'resolve_check_return',
  'deposit_action',
  'save_checkalt_settings',
  'save_checkalt_tenant_auto_deposit',
  'claim_ledger_link_or_create',
  'admin_override_check_status',
]);

const SESSION_RPCS = new Set(['register_session', 'validate_session', 'invalidate_session', 'log_audit']);

/** Auto-Deposit / CheckAlt Settings persist. Gated by AWS_WRITES_ENABLED, not the T5 workflow flag.
 *  Isolated production has endorsement writes on (AWS_WRITES_ENABLED) while
 *  AWS_APPLICATION_WORKFLOW_WRITES_ENABLED stays false. The Freedom $2,000
 *  ceiling save never reached RDS because this RPC was behind the T5 flag.
 */
export const CHECKALT_SETTINGS_RPCS = new Set([
  'save_checkalt_settings',
  'save_checkalt_tenant_auto_deposit',
]);

export const safeWriteRpcGate = (name, deps = {}) => {
  if (!SAFE_WRITE_RPCS.has(name)) {
    return { allowed: false, error: 'rpc_disabled', useWritesFlag: false };
  }
  const sessionLike = SESSION_RPCS.has(name);
  const checkaltSettings = CHECKALT_SETTINGS_RPCS.has(name);
  const useWritesFlag = sessionLike || checkaltSettings;
  const enabled = deps.forceEnabled === true
    || (useWritesFlag ? writesEnabled() : applicationWorkflowWritesEnabled());
  if (!enabled) {
    return {
      allowed: false,
      error: useWritesFlag ? 'writes_disabled' : 'application_workflow_writes_disabled',
      useWritesFlag,
    };
  }
  return { allowed: true, useWritesFlag };
};

/** Deposit Ops actions that do not move money or call a provider. */
export const SAFE_DEPOSIT_ACTIONS = new Set([
  'prepare_deposit',
  'assign_provider',
]);

const CHECKALT_SETTINGS_COLUMNS = new Set([
  'base_url',
  'merchant',
  'fi_key',
  'business_unit',
  'depositor_account_id',
  'default_enabled',
  'auto_approve_enabled',
  'auto_approve_max_cents',
  'notes',
]);

const CHECKALT_SETTINGS_SECRETS = new Set([
  'cached_jwt',
  'cached_jwt_expires_at',
  'webhook_secret',
]);

const CHECKALT_AUTO_DEPOSIT_COLUMNS = new Set([
  'auto_approve_enabled',
  'auto_approve_max_cents',
]);

export const AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL =
  'SELECT public.aws_save_checkalt_tenant_auto_deposit($1::uuid, $2::jsonb) AS result';

export { IS_PLATFORM_OWNER_SQL };

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  providerExecution: false,
  productionSupabaseChanged: false,
  ...extra,
});

const ok = ({ mapping, claims, spoof, data }) => ({
  ok: true,
  statusCode: 200,
  data,
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'rls',
  providerExecution: false,
  productionSupabaseChanged: false,
  writesEnabled: true,
});

const rolesOf = async (client, userId) => {
  const rows = (await client.query(USER_ROLES_SQL, [userId])).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

const requireRole = async (client, userId, allowed) => {
  const roles = await rolesOf(client, userId);
  if (![...allowed].some((role) => roles.has(role))) {
    return { error: 'not_authorized', message: 'Insufficient role for this workflow RPC' };
  }
  return { roles };
};

const arg = (args, ...keys) => {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) return args[key];
  }
  return null;
};

const executeLogAudit = async ({ client, mapping, args }) => {
  const action = String(arg(args, 'p_action') || '').trim();
  const recordType = String(arg(args, 'p_record_type') || '').trim();
  if (!action || !recordType) {
    return { error: 'missing_required_field', field: !action ? 'p_action' : 'p_record_type' };
  }
  const parseJson = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
  };
  const rows = (await client.query(
    `INSERT INTO public.audit_logs (
       user_id, action, record_type, record_id, old_values, new_values, metadata
     ) VALUES (
       $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::jsonb
     ) RETURNING id`,
    [
      mapping.application_user_id,
      action.slice(0, 120),
      recordType.slice(0, 120),
      arg(args, 'p_record_id') == null ? null : String(arg(args, 'p_record_id')).slice(0, 200),
      parseJson(arg(args, 'p_old_values')),
      parseJson(arg(args, 'p_new_values')),
      parseJson(arg(args, 'p_metadata')),
    ],
  )).rows;
  return { data: rows[0]?.id || null };
};

const executeRegisterSession = async ({ client, mapping, args }) => {
  const token = String(arg(args, 'p_session_token') || '').trim();
  if (!token || token.length > 200) return { error: 'invalid_field', field: 'p_session_token' };
  await client.query(
    `UPDATE public.user_sessions SET is_active = false
     WHERE user_id = $1::uuid AND is_active = true`,
    [mapping.application_user_id],
  );
  const roleVersion = (await client.query(
    'SELECT version FROM public.role_version_tracker WHERE user_id = $1::uuid',
    [mapping.application_user_id],
  )).rows[0]?.version ?? 1;
  const rows = (await client.query(
    `INSERT INTO public.user_sessions (
       user_id, session_token, device_info, ip_address, role_version
     ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::int)
     RETURNING id`,
    [
      mapping.application_user_id,
      token,
      arg(args, 'p_device_info') == null ? null : String(arg(args, 'p_device_info')).slice(0, 500),
      arg(args, 'p_ip_address') == null ? null : String(arg(args, 'p_ip_address')).slice(0, 80),
      roleVersion,
    ],
  )).rows;
  return { data: rows[0]?.id || null };
};

const executeValidateSession = async ({ client, mapping, args }) => {
  const token = String(arg(args, 'p_session_token') || '').trim();
  if (!token) return { data: [{ is_valid: false, reason: 'No session token', user_id: null }] };
  const session = (await client.query(
    `SELECT * FROM public.user_sessions
     WHERE session_token = $1::text AND is_active = true AND user_id = $2::uuid`,
    [token, mapping.application_user_id],
  )).rows[0];
  if (!session) {
    return { data: [{ is_valid: false, reason: 'Session not found or inactive', user_id: null }] };
  }
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    await client.query('UPDATE public.user_sessions SET is_active = false WHERE id = $1::uuid', [session.id]);
    return { data: [{ is_valid: false, reason: 'Session expired', user_id: session.user_id }] };
  }
  if (session.last_activity_at && new Date(session.last_activity_at) < new Date(Date.now() - 30 * 60 * 1000)) {
    await client.query('UPDATE public.user_sessions SET is_active = false WHERE id = $1::uuid', [session.id]);
    return { data: [{ is_valid: false, reason: 'Session timed out due to inactivity', user_id: session.user_id }] };
  }
  await client.query(
    `UPDATE public.user_sessions SET last_activity_at = now() WHERE id = $1::uuid`,
    [session.id],
  );
  return { data: [{ is_valid: true, reason: 'Valid', user_id: session.user_id }] };
};

const executeInvalidateSession = async ({ client, mapping, args }) => {
  const token = String(arg(args, 'p_session_token') || '').trim();
  if (!token) return { data: false };
  const result = await client.query(
    `UPDATE public.user_sessions SET is_active = false
     WHERE session_token = $1::text AND user_id = $2::uuid`,
    [token, mapping.application_user_id],
  );
  return { data: (result.rowCount || 0) > 0 };
};

const executeAcceptMortgage = async ({ client, mapping, args }) => {
  const gated = await requireRole(client, mapping.application_user_id, ['admin', 'mortgage_agent']);
  if (gated.error) return gated;
  const requestId = arg(args, '_request_id', 'request_id');
  if (!isUuid(requestId)) return { error: 'invalid_uuid', field: '_request_id' };
  const rows = (await client.query(
    `UPDATE public.mortgage_handling_requests
     SET assigned_employee_id = $2::uuid,
         status = 'in_progress',
         accepted_at = COALESCE(accepted_at, now()),
         updated_at = now()
     WHERE id = $1::uuid
       AND assigned_employee_id IS NULL
       AND status = 'requested'
     RETURNING *`,
    [requestId, mapping.application_user_id],
  )).rows;
  if (!rows.length) return { error: 'already_taken', message: 'already_taken' };
  return { data: rows[0] };
};

const executeUpdateMortgageStatus = async ({ client, mapping, args }) => {
  const gated = await requireRole(client, mapping.application_user_id, ['admin', 'mortgage_agent']);
  if (gated.error) return gated;
  const requestId = arg(args, '_request_id', 'request_id');
  const status = String(arg(args, '_status', 'status') || '').trim();
  const notes = arg(args, '_notes', 'notes');
  if (!isUuid(requestId)) return { error: 'invalid_uuid', field: '_request_id' };
  if (!['in_progress', 'completed', 'cancelled'].includes(status)) {
    return { error: 'invalid_status', message: 'invalid_status' };
  }
  const isAdmin = gated.roles.has('admin');
  const rows = (await client.query(
    `UPDATE public.mortgage_handling_requests
     SET status = $2::text,
         completed_at = CASE WHEN $2::text = 'completed' THEN now() ELSE completed_at END,
         work_notes = CASE
           WHEN $3::text IS NULL OR length(trim($3::text)) = 0 THEN work_notes
           ELSE COALESCE(work_notes || E'\n\n', '') ||
                to_char(now(), 'YYYY-MM-DD HH24:MI') || ' — ' || trim($3::text)
         END,
         updated_at = now()
     WHERE id = $1::uuid
       AND (assigned_employee_id = $4::uuid OR $5::boolean)
     RETURNING *`,
    [requestId, status, notes == null ? null : String(notes).slice(0, 4000), mapping.application_user_id, isAdmin],
  )).rows;
  if (!rows.length) return { error: 'not_assigned_to_you', message: 'not_assigned_to_you' };
  return { data: rows[0] };
};

const executeInitLossDraftDocuments = async () => ({ data: null });

const executeLossDraftSetLender = async ({ client, mapping, args }) => {
  const draftId = arg(args, 'p_loss_draft_id');
  const lenderName = String(arg(args, 'p_lender_name') || '').trim();
  if (!isUuid(draftId)) return { error: 'invalid_uuid', field: 'p_loss_draft_id' };
  if (!lenderName) return { error: 'invalid_field', field: 'p_lender_name' };
  const draft = (await client.query(
    `SELECT ld.*, ci.tenant_id
     FROM public.loss_draft_tracking ld
     LEFT JOIN public.check_intake_items ci ON ci.id = ld.check_intake_item_id
     WHERE ld.id = $1::uuid`,
    [draftId],
  )).rows[0];
  if (!draft) return { error: 'rls_denied', message: 'Loss draft record not found' };
  const roles = await rolesOf(client, mapping.application_user_id);
  const member = draft.tenant_id
    ? (await client.query(
      `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
      [mapping.application_user_id, draft.tenant_id],
    )).rows[0]
    : null;
  if (!roles.has('admin') && !roles.has('staff') && !member) {
    return { error: 'not_authorized', message: 'Not authorized' };
  }
  let companyId = (await client.query(
    `SELECT id FROM public.mortgage_companies WHERE lower(name) = lower($1::text) ORDER BY created_at ASC LIMIT 1`,
    [lenderName],
  )).rows[0]?.id || null;
  if (!companyId) {
    companyId = (await client.query(
      `INSERT INTO public.mortgage_companies (name, is_active)
       VALUES ($1::text, true)
       RETURNING id`,
      [lenderName.slice(0, 200)],
    )).rows[0]?.id;
  }
  const rows = (await client.query(
    `UPDATE public.loss_draft_tracking
     SET mortgage_servicer = $2::text,
         mortgage_company_id = $3::uuid,
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [draftId, lenderName.slice(0, 200), companyId],
  )).rows;
  await client.query(
    `INSERT INTO public.loss_draft_audit_log (loss_draft_id, action, actor_id, notes)
     VALUES ($1::uuid, 'set_lender', $2::uuid, $3::text)`,
    [draftId, mapping.application_user_id, `Lender set to ${lenderName.slice(0, 200)}`],
  );
  return { data: null, row: rows[0] };
};

const executeLossDraftAction = async ({ client, mapping, args }) => {
  const draftId = arg(args, 'p_loss_draft_id');
  const action = String(arg(args, 'p_action') || '').trim();
  const notes = arg(args, 'p_notes');
  let extra = arg(args, 'p_extra') || {};
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { extra = {}; }
  }
  if (!isUuid(draftId)) return { error: 'invalid_uuid', field: 'p_loss_draft_id' };
  if (!SAFE_LOSS_DRAFT_ACTIONS.has(action)) {
    return {
      error: 'rpc_financial_disabled',
      message: `loss_draft_action '${action}' is financial/authorization-sensitive and remains disabled on AWS staging`,
      action,
    };
  }
  const draft = (await client.query(
    'SELECT * FROM public.loss_draft_tracking WHERE id = $1::uuid FOR UPDATE',
    [draftId],
  )).rows[0];
  if (!draft) return { error: 'rls_denied', message: 'Loss draft record not found' };
  const oldValues = {
    escrow_status: draft.escrow_status,
    monitoring_type: draft.monitoring_type,
  };
  const tracking = extra?.tracking_number ? String(extra.tracking_number).slice(0, 120) : null;

  if (action === 'set_monitoring_type') {
    const monitoringType = String(extra?.monitoring_type || 'monitored');
    if (!['monitored', 'not_monitored'].includes(monitoringType)) {
      return { error: 'invalid_field', field: 'monitoring_type' };
    }
    await client.query(
      `UPDATE public.loss_draft_tracking
       SET monitoring_type = $2::text, updated_at = now()
       WHERE id = $1::uuid`,
      [draftId, monitoringType],
    );
  } else if (action === 'mark_sent') {
    await client.query(
      `UPDATE public.loss_draft_tracking
       SET escrow_status = 'sent_to_lender',
           check_sent_date = COALESCE(check_sent_date, CURRENT_DATE),
           tracking_number_sent = COALESCE($2::text, tracking_number_sent),
           last_contact_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [draftId, tracking],
    );
  } else if (action === 'mark_received_back') {
    await client.query(
      `UPDATE public.loss_draft_tracking
       SET escrow_status = 'check_received_back',
           check_received_back_date = COALESCE(check_received_back_date, CURRENT_DATE),
           updated_at = now()
       WHERE id = $1::uuid`,
      [draftId],
    );
  } else if (action === 'send_for_endorsements') {
    await client.query(
      `UPDATE public.loss_draft_tracking
       SET escrow_status = 'endorsing', updated_at = now()
       WHERE id = $1::uuid`,
      [draftId],
    );
    if (draft.check_intake_item_id) {
      await client.query(
        `UPDATE public.check_intake_items
         SET status = 'endorsements_in_progress',
             check_stage = 'endorsing',
             updated_at = now()
         WHERE id = $1::uuid
           AND deposited_at IS NULL`,
        [draft.check_intake_item_id],
      );
    }
  } else if (action === 'admin_reset_status') {
    const gated = await requireRole(client, mapping.application_user_id, ['admin', 'staff']);
    if (gated.error) return gated;
    const target = String(extra?.target_status || '').trim();
    if (!SAFE_LOSS_DRAFT_RESET_STATUSES.has(target)) {
      return {
        error: 'rpc_financial_disabled',
        message: `admin_reset_status to '${target}' is not enabled (financial or unsupported)`,
        target,
      };
    }
    if (target === 'endorsing') {
      if (draft.check_intake_item_id) {
        await client.query(
          `UPDATE public.check_intake_items
           SET status = 'endorsements_in_progress',
               check_stage = 'endorsing',
               updated_at = now()
           WHERE id = $1::uuid AND deposited_at IS NULL`,
          [draft.check_intake_item_id],
        );
        await client.query(
          `INSERT INTO public.check_audit_log (
             check_id, tenant_id, actor_id, event_type, event_description, event_data
           ) VALUES (
             $1::uuid,
             (SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid),
             $2::uuid,
             'loss_draft_moved_to_endorsing',
             'Admin reset moved check to Endorsing; loss draft tracking removed.',
             $3::jsonb
           )`,
          [
            draft.check_intake_item_id,
            mapping.application_user_id,
            JSON.stringify({ loss_draft_id: draftId, prior_escrow_status: draft.escrow_status }),
          ],
        );
      }
      await client.query('DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = $1::uuid', [draftId]);
      await client.query('DELETE FROM public.loss_draft_documents WHERE loss_draft_id = $1::uuid', [draftId]);
      await client.query('DELETE FROM public.loss_draft_tracking WHERE id = $1::uuid', [draftId]);
      return { data: null };
    }
    await client.query(
      `UPDATE public.loss_draft_tracking
       SET escrow_status = $2::text, updated_at = now()
       WHERE id = $1::uuid`,
      [draftId, target],
    );
  }

  const updated = (await client.query(
    'SELECT escrow_status, monitoring_type FROM public.loss_draft_tracking WHERE id = $1::uuid',
    [draftId],
  )).rows[0];
  if (updated) {
    await client.query(
      `INSERT INTO public.loss_draft_audit_log (
         loss_draft_id, action, actor_id, amount, notes, old_values, new_values
       ) VALUES ($1::uuid, $2::text, $3::uuid, NULL, $4::text, $5::jsonb, $6::jsonb)`,
      [
        draftId,
        action,
        mapping.application_user_id,
        notes == null ? null : String(notes).slice(0, 2000),
        JSON.stringify(oldValues),
        JSON.stringify(updated),
      ],
    );
  }
  return { data: null };
};

const executeHomeownerIntro = async ({ client, args }) => {
  const profileId = arg(args, '_contractor_profile_id', 'contractor_profile_id');
  const name = String(arg(args, '_homeowner_name', 'homeowner_name') || '').trim();
  const email = String(arg(args, '_homeowner_email', 'homeowner_email') || '').trim().toLowerCase();
  const phone = arg(args, '_homeowner_phone', 'homeowner_phone');
  const zip = arg(args, '_property_zip', 'property_zip');
  const lossType = arg(args, '_loss_type', 'loss_type');
  const message = arg(args, '_message', 'message');
  if (!isUuid(profileId)) return { error: 'invalid_uuid', field: '_contractor_profile_id' };
  if (name.length < 2) return { error: 'invalid_field', field: 'homeowner_name' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'invalid_field', field: 'homeowner_email' };
  const contractor = (await client.query(
    `SELECT id, user_id FROM public.contractor_profiles
     WHERE id = $1::uuid AND is_directory_listed = true AND directory_opt_in = true`,
    [profileId],
  )).rows[0];
  if (!contractor?.user_id) {
    return { error: 'contractor_not_accepting_leads', message: 'contractor not accepting leads' };
  }
  const rows = (await client.query(
    `INSERT INTO public.homeowner_intro_requests (
       contractor_profile_id, contractor_user_id,
       homeowner_name, homeowner_email, homeowner_phone,
       property_zip, loss_type, message
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text
     ) RETURNING id, access_token`,
    [
      profileId,
      contractor.user_id,
      name.slice(0, 120),
      email.slice(0, 255),
      phone == null || phone === '' ? null : String(phone).slice(0, 30),
      zip == null || zip === '' ? null : String(zip).slice(0, 10),
      lossType == null || lossType === '' ? null : String(lossType).slice(0, 80),
      message == null || message === '' ? null : String(message).slice(0, 1000),
    ],
  )).rows;
  return { data: rows[0] ? [{ id: rows[0].id, access_token: rows[0].access_token }] : [] };
};

const executeResolveCheckCase = async ({ client, mapping, args }) => {
  const tenantId = arg(args, '_tenant_id', 'tenant_id');
  if (!isUuid(tenantId)) return { error: 'invalid_uuid', field: '_tenant_id' };
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     UNION ALL
     SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role IN ('admin', 'staff')`,
    [mapping.application_user_id, tenantId],
  )).rows[0];
  if (!member) return { error: 'not_authorized', message: 'Not a member of tenant' };
  const claimId = arg(args, '_claim_id', 'claim_id');
  const externalClaimId = arg(args, '_external_claim_id', 'external_claim_id');
  const claimNumber = arg(args, '_claim_number', 'claim_number');
  const insuredName = arg(args, '_insured_name', 'insured_name');
  const propertyAddress = arg(args, '_property_address', 'property_address');
  const carrierName = arg(args, '_carrier_name', 'carrier_name');
  const vExt = claimId || externalClaimId;
  if (vExt && isUuid(vExt)) {
    const existing = (await client.query(
      `SELECT id FROM public.check_cases
       WHERE external_system = 'freedom_crm' AND external_claim_id = $1::uuid LIMIT 1`,
      [vExt],
    )).rows[0];
    if (existing) return { data: existing.id };
  }
  if (!vExt && !claimNumber) return { data: null };
  if (!vExt && claimNumber) {
    const byNumber = (await client.query(
      `SELECT id FROM public.check_cases
       WHERE tenant_id = $1::uuid AND external_claim_id IS NULL
         AND claim_number IS NOT DISTINCT FROM $2::text
       LIMIT 1`,
      [tenantId, claimNumber],
    )).rows[0];
    if (byNumber) return { data: byNumber.id };
  }
  let claim = null;
  if (claimId && isUuid(claimId)) {
    claim = (await client.query('SELECT * FROM public.claims WHERE id = $1::uuid', [claimId])).rows[0] || null;
  }
  const inserted = (await client.query(
    `INSERT INTO public.check_cases (
       tenant_id, external_system, external_claim_id, claim_number, insured_name,
       insured_email, insured_phone, property_address, carrier_name, policy_number,
       mortgage_company_id, loan_number, loss_date
     ) VALUES (
       $1::uuid, $2::text, $3::uuid, $4::text, $5::text,
       $6::text, $7::text, $8::text, $9::text, $10::text,
       $11::uuid, $12::text, $13::date
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      tenantId,
      vExt ? 'freedom_crm' : 'checksops',
      vExt && isUuid(vExt) ? vExt : null,
      claim?.claim_number || claimNumber || null,
      claim?.policyholder_name || insuredName || null,
      claim?.policyholder_email || null,
      claim?.policyholder_phone || null,
      claim?.policyholder_address || propertyAddress || null,
      claim?.insurance_company || carrierName || null,
      claim?.policy_number || null,
      claim?.mortgage_company_id || null,
      claim?.loan_number || null,
      claim?.loss_date || null,
    ],
  )).rows[0];
  if (inserted) return { data: inserted.id };
  if (vExt && isUuid(vExt)) {
    const again = (await client.query(
      `SELECT id FROM public.check_cases
       WHERE external_system = 'freedom_crm' AND external_claim_id = $1::uuid LIMIT 1`,
      [vExt],
    )).rows[0];
    return { data: again?.id || null };
  }
  return { data: null };
};

const executeAdminSetContractorPro = async ({ client, mapping, args }) => {
  const gated = await requireRole(client, mapping.application_user_id, ['admin']);
  if (gated.error) return gated;
  const contractorId = arg(args, 'p_contractor_id', 'contractor_id');
  const approve = arg(args, 'p_approve', 'approve');
  if (!isUuid(contractorId)) return { error: 'invalid_uuid', field: 'p_contractor_id' };
  const approveBool = approve === true || approve === 'true';
  if (approveBool) {
    await client.query(
      `UPDATE public.contractor_profiles
       SET tier = 'pro',
           pro_approved_at = now(),
           pro_approved_by = $2::uuid,
           verified_at = COALESCE(verified_at, now()),
           updated_at = now()
       WHERE id = $1::uuid`,
      [contractorId, mapping.application_user_id],
    );
  } else {
    await client.query(
      `UPDATE public.contractor_profiles
       SET pro_approved_at = NULL,
           pro_approved_by = NULL,
           updated_at = now()
       WHERE id = $1::uuid`,
      [contractorId],
    );
  }
  const status = (await client.query(
    'SELECT * FROM public.contractor_verification_status($1::uuid)',
    [contractorId],
  )).rows[0];
  return { data: status || { ok: true } };
};

const executeRecordCheckReturn = async ({ client, mapping, args }) => {
  const checkId = arg(args, 'p_check_id', 'check_id');
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
  const check = (await client.query(
    `SELECT id, tenant_id, check_stage, status FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'Check not found' };
  const roles = await rolesOf(client, mapping.application_user_id);
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
    [mapping.application_user_id, check.tenant_id],
  )).rows[0];
  if (!roles.has('admin') && !roles.has('staff') && !member) {
    return { error: 'not_authorized', message: 'Not authorized to record a return for this check' };
  }
  if (check.check_stage === 'returned') {
    return { data: { ok: true, already_returned: true, check_id: checkId } };
  }
  const returnCode = arg(args, 'p_return_code') == null ? null : String(arg(args, 'p_return_code')).slice(0, 80);
  const returnReason = arg(args, 'p_return_reason') == null ? null : String(arg(args, 'p_return_reason')).slice(0, 500);
  const notes = arg(args, 'p_notes') == null ? null : String(arg(args, 'p_notes')).slice(0, 2000);
  const source = String(arg(args, 'p_source') || 'manual').slice(0, 40);
  await client.query(
    `UPDATE public.check_intake_items
     SET check_stage = 'returned'::public.check_stage,
         status = 'returned',
         pre_return_stage = $2::public.check_stage,
         returned_at = COALESCE($3::timestamptz, now()),
         return_code = $4::text,
         return_reason = $5::text,
         return_notes = $6::text,
         return_recorded_by = $7::uuid,
         return_source = $8::text,
         return_resolved_at = NULL,
         return_resolution = NULL,
         updated_at = now()
     WHERE id = $1::uuid`,
    [
      checkId,
      check.check_stage,
      arg(args, 'p_returned_at'),
      returnCode,
      returnReason,
      notes,
      mapping.application_user_id,
      source,
    ],
  );
  await client.query(
    `UPDATE public.claim_checks SET deposit_status = 'returned' WHERE check_intake_item_id = $1::uuid`,
    [checkId],
  ).catch(() => {});
  await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'check_returned',
       $4::text, $5::jsonb
     )`,
    [
      checkId,
      check.tenant_id,
      mapping.application_user_id,
      `Check returned: ${returnReason || returnCode || 'unspecified'}`,
      JSON.stringify({
        return_code: returnCode,
        return_reason: returnReason,
        previous_stage: check.check_stage,
        source,
        notes,
        provider_execution: false,
      }),
    ],
  );
  return { data: { ok: true, check_id: checkId, previous_stage: check.check_stage } };
};

const truthy = (value) => value === true || value === 'true' || value === 1 || value === '1';

const requireManagerAdmin = async (client, userId) => {
  const roles = await rolesOf(client, userId);
  if (roles.has('admin') || roles.has('staff')) return { roles };
  const tenantAdmin = (await client.query(
    `SELECT 1 FROM public.tenant_users
     WHERE user_id = $1::uuid AND lower(role::text) IN ('admin', 'owner')`,
    [userId],
  )).rows[0];
  if (!tenantAdmin) {
    return { error: 'not_authorized', message: 'Insufficient role for this workflow RPC' };
  }
  return { roles };
};

const requirePlatformOwner = async (client) => {
  const row = (await client.query(IS_PLATFORM_OWNER_SQL)).rows[0];
  if (!row?.is_owner) {
    return { error: 'not_authorized', message: 'Platform owner required for CheckAlt settings' };
  }
  return { ok: true };
};

const requireOwnTenantAdmin = async (client, userId, tenantId) => {
  const owner = await requirePlatformOwner(client);
  if (!owner.error) return { ok: true, platformOwner: true };
  if (!isUuid(tenantId)) {
    return { error: 'invalid_uuid', field: 'tenant_id' };
  }
  const tenantAdmin = (await client.query(
    `SELECT 1 FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND lower(role::text) IN ('admin', 'owner')`,
    [userId, tenantId],
  )).rows[0];
  if (!tenantAdmin) {
    return { error: 'not_authorized', message: 'Insufficient role for this workflow RPC' };
  }
  return { ok: true };
};

const canAccessTenant = async (client, userId, tenantId) => {
  if (!isUuid(tenantId)) return false;
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
    [userId, tenantId],
  )).rows[0];
  if (member) return true;
  const roles = await rolesOf(client, userId);
  return roles.has('admin');
};

const executeResolveCheckReturn = async ({ client, mapping, args }) => {
  const checkId = arg(args, 'p_check_id', 'check_id');
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
  const check = (await client.query(
    `SELECT id, tenant_id, check_stage, pre_return_stage, status
     FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'Check not found' };
  const roles = await rolesOf(client, mapping.application_user_id);
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
    [mapping.application_user_id, check.tenant_id],
  )).rows[0];
  if (!roles.has('admin') && !roles.has('staff') && !member) {
    return { error: 'not_authorized', message: 'Not authorized' };
  }
  if (check.check_stage !== 'returned') {
    return { data: { ok: true, already_resolved: true, check_id: checkId } };
  }
  const restoreRequested = truthy(arg(args, 'p_restore_stage', 'restore_stage'));
  const restoreStage = restoreRequested ? (check.pre_return_stage || 'review') : 'returned';
  const resolution = arg(args, 'p_resolution') == null ? 'resolved' : String(arg(args, 'p_resolution')).slice(0, 120);
  if (restoreRequested) {
    await client.query(
      `UPDATE public.check_intake_items
       SET check_stage = $2::public.check_stage,
           status = CASE WHEN $2::text = 'returned' THEN status ELSE COALESCE(status, 'needs_review') END,
           return_resolved_at = now(),
           return_resolution = $3::text,
           updated_at = now()
       WHERE id = $1::uuid`,
      [checkId, restoreStage, resolution],
    );
  } else {
    await client.query(
      `UPDATE public.check_intake_items
       SET return_resolved_at = now(),
           return_resolution = $2::text,
           updated_at = now()
       WHERE id = $1::uuid`,
      [checkId, resolution],
    );
  }
  await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'check_return_resolved',
       'Check return resolved', $4::jsonb
     )`,
    [
      checkId,
      check.tenant_id,
      mapping.application_user_id,
      JSON.stringify({
        restored_stage: restoreRequested ? restoreStage : null,
        restore_stage: restoreRequested,
        resolution,
        provider_execution: false,
      }),
    ],
  );
  return {
    data: {
      ok: true,
      check_id: checkId,
      restored_stage: restoreRequested ? restoreStage : null,
      restore_stage: restoreRequested,
      check_stage: restoreStage,
    },
  };
};

const executeSaveCheckaltSettings = async ({ client, mapping, args }) => {
  const gated = await requirePlatformOwner(client);
  if (gated.error) return gated;
  const incoming = args && typeof args === 'object' ? { ...args } : {};
  const nested = incoming.p_settings && typeof incoming.p_settings === 'object' ? incoming.p_settings : incoming;
  const updates = [];
  const params = [];
  for (const [key, value] of Object.entries(nested)) {
    if (key.startsWith('p_') && key !== 'p_settings') continue;
    if (CHECKALT_SETTINGS_SECRETS.has(key)) {
      return { error: 'secret_column_denied', field: key };
    }
    if (!CHECKALT_SETTINGS_COLUMNS.has(key)) continue;
    params.push(value);
    updates.push(`${key} = $${params.length}`);
  }
  if (!updates.length) return { error: 'missing_required_field', field: 'settings' };
  params.push(mapping.application_user_id);
  updates.push(`updated_by = $${params.length}`);
  updates.push('updated_at = now()');
  const rows = (await client.query(
    `UPDATE public.checkalt_config
     SET ${updates.join(', ')}
     WHERE singleton = true
     RETURNING id, singleton, base_url, merchant, fi_key, business_unit,
               depositor_account_id, default_enabled, auto_approve_enabled,
               auto_approve_max_cents, notes, created_at, updated_at, updated_by`,
    params,
  )).rows;
  return { data: rows[0] || null };
};

const executeSaveCheckaltTenantAutoDeposit = async ({ client, mapping, args }) => {
  const incoming = args && typeof args === 'object' ? { ...args } : {};
  const nested = incoming.p_settings && typeof incoming.p_settings === 'object'
    ? incoming.p_settings
    : incoming;
  let tenantId = arg(incoming, 'p_tenant_id', 'tenant_id')
    || arg(nested, 'p_tenant_id', 'tenant_id');
  if (!tenantId) {
    const memberships = (await client.query(
      `SELECT tenant_id FROM public.tenant_users WHERE user_id = $1::uuid`,
      [mapping.application_user_id],
    )).rows;
    if (memberships.length !== 1) {
      return { error: 'missing_required_field', field: 'tenant_id' };
    }
    tenantId = memberships[0].tenant_id;
  }
  const gated = await requireOwnTenantAdmin(client, mapping.application_user_id, tenantId);
  if (gated.error) return gated;
  for (const key of Object.keys(nested)) {
    if (key.startsWith('p_') && key !== 'p_settings') continue;
    if (key === 'tenant_id' || key === 'p_tenant_id' || key === 'p_settings') continue;
    if (!CHECKALT_AUTO_DEPOSIT_COLUMNS.has(key)) {
      return { error: 'invalid_field', field: key };
    }
  }
  const hasEnabled = Object.prototype.hasOwnProperty.call(nested, 'auto_approve_enabled');
  const hasMax = Object.prototype.hasOwnProperty.call(nested, 'auto_approve_max_cents');
  if (!hasEnabled && !hasMax) {
    return { error: 'missing_required_field', field: 'auto_approve_enabled' };
  }
  let maxCents = hasMax ? nested.auto_approve_max_cents : undefined;
  if (maxCents === '' || maxCents === undefined) {
    maxCents = hasMax ? null : undefined;
  }
  if (maxCents != null) {
    maxCents = Number(maxCents);
    if (!Number.isFinite(maxCents) || maxCents < 0) {
      return { error: 'invalid_field', field: 'auto_approve_max_cents' };
    }
    maxCents = Math.round(maxCents);
  }
  const settings = {};
  if (hasEnabled) settings.auto_approve_enabled = truthy(nested.auto_approve_enabled);
  if (hasMax) settings.auto_approve_max_cents = maxCents;
  try {
    const rows = (await client.query(AWS_SAVE_CHECKALT_TENANT_AUTO_DEPOSIT_SQL, [
      tenantId,
      settings,
    ])).rows;
    return { data: rows[0]?.result || null };
  } catch (error) {
    const message = String(error?.message || '');
    if (/not_authorized/i.test(message) || error?.code === '42501') {
      return { error: 'not_authorized', message: 'Insufficient role for this workflow RPC' };
    }
    if (/invalid_field/i.test(message) || error?.code === '22023') {
      return { error: 'invalid_field', field: 'auto_approve_max_cents' };
    }
    if (/missing_required_field/i.test(message)) {
      return { error: 'missing_required_field', field: 'auto_approve_enabled' };
    }
    if (/not_found/i.test(message) || error?.code === 'P0002') {
      return { error: 'rls_denied', message: 'Auto-Deposit account not found' };
    }
    throw error;
  }
};

const executeDepositAction = async ({ client, mapping, args }) => {
  const action = String(arg(args, 'p_action', 'action') || '').trim();
  if (!action) return { error: 'missing_required_field', field: 'p_action' };
  if (!SAFE_DEPOSIT_ACTIONS.has(action)) {
    return {
      error: 'rpc_financial_disabled',
      message: `deposit_action '${action}' is not enabled (money movement or provider-sensitive)`,
      action,
    };
  }
  const gated = await requireManagerAdmin(client, mapping.application_user_id);
  if (gated.error) return gated;
  const actorId = mapping.application_user_id;
  const notes = arg(args, 'p_notes', 'notes');

  if (action === 'prepare_deposit') {
    const checkId = arg(args, 'p_check_id', 'check_id');
    if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
    const check = (await client.query(
      `SELECT id, tenant_id, status, amount, check_number, carrier_name, claim_id
       FROM public.check_intake_items WHERE id = $1::uuid FOR UPDATE`,
      [checkId],
    )).rows[0];
    if (!check) return { error: 'rls_denied', message: 'Check not found' };
    if (!(await canAccessTenant(client, actorId, check.tenant_id))) {
      return { error: 'not_authorized', message: 'Not authorized' };
    }
    if (check.status !== 'approved_for_deposit') {
      return { error: 'invalid_status', message: `Check must be approved_for_deposit, got: ${check.status}` };
    }
    const existing = (await client.query(
      'SELECT id FROM public.deposit_items WHERE check_id = $1::uuid',
      [checkId],
    )).rows[0];
    if (existing) {
      return { error: 'invalid_status', message: 'duplicate_submission: Check already in deposit pipeline' };
    }
    const item = (await client.query(
      `INSERT INTO public.deposit_items (check_id, amount, check_number, carrier_name, claim_id)
       VALUES ($1::uuid, $2::numeric, $3::text, $4::text, $5::uuid)
       RETURNING id`,
      [checkId, check.amount ?? 0, check.check_number, check.carrier_name, check.claim_id],
    )).rows[0];
    await client.query(
      `INSERT INTO public.deposit_audit_log (deposit_item_id, action, actor_id, amount, notes)
       VALUES ($1::uuid, 'prepare_deposit', $2::uuid, $3::numeric, $4::text)`,
      [item.id, actorId, check.amount, notes == null ? null : String(notes).slice(0, 2000)],
    );
    return { data: { success: true, deposit_item_id: item.id } };
  }

  const depositItemId = arg(args, 'p_deposit_item_id', 'deposit_item_id');
  const provider = arg(args, 'p_provider', 'provider');
  if (!isUuid(depositItemId)) return { error: 'invalid_uuid', field: 'p_deposit_item_id' };
  if (!provider) return { error: 'missing_required_field', field: 'p_provider' };
  const item = (await client.query(
    `SELECT di.id, di.status, di.amount, di.check_id, ci.tenant_id
     FROM public.deposit_items di
     JOIN public.check_intake_items ci ON ci.id = di.check_id
     WHERE di.id = $1::uuid
     FOR UPDATE OF di`,
    [depositItemId],
  )).rows[0];
  if (!item) return { error: 'rls_denied', message: 'Deposit item not found' };
  if (!(await canAccessTenant(client, actorId, item.tenant_id))) {
    return { error: 'not_authorized', message: 'Not authorized' };
  }
  if (item.status !== 'pending_assignment') {
    return { error: 'invalid_status', message: `Invalid transition: ${item.status} -> assign_provider` };
  }
  const active = (await client.query(
    `SELECT 1 FROM public.deposit_provider_config
     WHERE provider = $1::text AND is_active = true`,
    [String(provider)],
  )).rows[0];
  if (!active) {
    return { error: 'invalid_field', field: 'p_provider', message: `Provider "${provider}" is not active or not configured` };
  }
  const batchId = arg(args, 'p_batch_id', 'batch_id');
  let resolvedBatchId = isUuid(batchId) ? batchId : null;
  if (!resolvedBatchId) {
    resolvedBatchId = (await client.query(
      `INSERT INTO public.deposit_batches (provider, total_items, total_amount, created_by)
       VALUES ($1::public.deposit_provider, 1, $2::numeric, $3::uuid)
       RETURNING id`,
      [String(provider), item.amount, actorId],
    )).rows[0]?.id;
  } else {
    await client.query(
      `UPDATE public.deposit_batches
       SET total_items = total_items + 1,
           total_amount = total_amount + $2::numeric,
           updated_at = now()
       WHERE id = $1::uuid`,
      [resolvedBatchId, item.amount],
    );
  }
  await client.query(
    `UPDATE public.deposit_items
     SET provider = $2::public.deposit_provider,
         batch_id = $3::uuid,
         status = 'provider_assigned',
         updated_at = now()
     WHERE id = $1::uuid`,
    [depositItemId, String(provider), resolvedBatchId],
  );
  await client.query(
    `INSERT INTO public.deposit_audit_log (
       deposit_item_id, batch_id, action, actor_id, amount, notes, new_values
     ) VALUES (
       $1::uuid, $2::uuid, 'assign_provider', $3::uuid, $4::numeric, $5::text, $6::jsonb
     )`,
    [
      depositItemId,
      resolvedBatchId,
      actorId,
      item.amount,
      notes == null ? null : String(notes).slice(0, 2000),
      JSON.stringify({ provider: String(provider), batch_id: resolvedBatchId }),
    ],
  );
  return { data: { success: true, batch_id: resolvedBatchId } };
};

export const CLAIM_LEDGER_LINK_OR_CREATE_SQL =
  'SELECT public.claim_ledger_link_or_create($1::uuid, $2::uuid, $3::text, $4::text) AS result';

const executeClaimLedgerLinkOrCreate = async ({ client, mapping, args }) => {
  const checkId = arg(args, 'p_check_id', 'check_id');
  const action = String(arg(args, 'p_action', 'action') || '').trim();
  const claimNumber = arg(args, 'p_claim_number', 'claim_number');
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
  if (!['inspect', 'link_existing', 'create_new'].includes(action)) {
    return { error: 'invalid_field', field: 'p_action' };
  }
  const check = (await client.query(
    `SELECT id, tenant_id, claim_id, deposited_at, check_stage::text AS check_stage
     FROM public.check_intake_items
     WHERE id = $1::uuid
     FOR UPDATE`,
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'check not found or not writable' };
  if (!isUuid(check.tenant_id)) {
    return { error: 'not_authorized', message: 'This check has no tenant, so it cannot be linked to a claim.' };
  }
  const roles = await rolesOf(client, mapping.application_user_id);
  const member = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
    [mapping.application_user_id, check.tenant_id],
  )).rows[0];
  if (!roles.has('admin') && !roles.has('staff') && !member) {
    return { error: 'not_authorized', message: 'Not authorized to link this check' };
  }
  const rpc = await client.query(CLAIM_LEDGER_LINK_OR_CREATE_SQL, [
    checkId,
    check.tenant_id,
    claimNumber == null ? null : String(claimNumber),
    action,
  ]);
  const result = rpc.rows?.[0]?.result || {};
  if (result.ok === false) {
    return {
      error: result.code || 'claim_ledger_failed',
      message: `Claim Ledger ${action} failed (${result.code || 'error'})`,
      result,
    };
  }
  return { data: result };
};

export const executeSafeWriteRpc = async ({ client, mapping, name, args }) => {
  switch (name) {
    case 'log_audit':
      return executeLogAudit({ client, mapping, args });
    case 'register_session':
      return executeRegisterSession({ client, mapping, args });
    case 'validate_session':
      return executeValidateSession({ client, mapping, args });
    case 'invalidate_session':
      return executeInvalidateSession({ client, mapping, args });
    case 'accept_mortgage_handling_request':
      return executeAcceptMortgage({ client, mapping, args });
    case 'update_mortgage_handling_request_status':
      return executeUpdateMortgageStatus({ client, mapping, args });
    case 'init_loss_draft_documents':
      return executeInitLossDraftDocuments();
    case 'loss_draft_set_lender':
      return executeLossDraftSetLender({ client, mapping, args });
    case 'loss_draft_action':
      return executeLossDraftAction({ client, mapping, args });
    case 'submit_homeowner_intro_request':
      return executeHomeownerIntro({ client, args });
    case 'resolve_check_case':
      return executeResolveCheckCase({ client, mapping, args });
    case 'admin_set_contractor_pro':
      return executeAdminSetContractorPro({ client, mapping, args });
    case 'record_check_return':
      return executeRecordCheckReturn({ client, mapping, args });
    case 'resolve_check_return':
      return executeResolveCheckReturn({ client, mapping, args });
    case 'save_checkalt_settings':
      return executeSaveCheckaltSettings({ client, mapping, args });
    case 'save_checkalt_tenant_auto_deposit':
      return executeSaveCheckaltTenantAutoDeposit({ client, mapping, args });
    case 'deposit_action':
      return executeDepositAction({ client, mapping, args });
    case 'claim_ledger_link_or_create':
      return executeClaimLedgerLinkOrCreate({ client, mapping, args });
    case 'admin_override_check_status':
      return executeAdminOverrideCheckStatus({ client, mapping, args });
    default:
      return { error: 'rpc_disabled', name };
  }
};

export const handleSafeWriteRpc = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  let name;
  try {
    name = String(body.name || body.rpc || '').replace(/^public\./, '');
  } catch {
    return denied(spoof, { statusCode: 400, error: 'invalid_rpc' });
  }
  const gate = safeWriteRpcGate(name, deps);
  if (!gate.allowed) {
    return denied(spoof, {
      error: gate.error,
      message: gate.error === 'rpc_disabled'
        ? undefined
        : (gate.useWritesFlag
          ? 'AWS writes are disabled by AWS_WRITES_ENABLED'
          : 'Application-workflow writes are disabled by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED'),
      name,
    });
  }

  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const executed = await executeSafeWriteRpc({ client, mapping, name, args });
    if (executed.error) {
      const status = executed.error === 'invalid_uuid'
        || executed.error === 'invalid_field'
        || executed.error === 'missing_required_field'
        || executed.error === 'invalid_status'
        ? 400
        : 403;
      return denied(spoof, { statusCode: status, name, ...executed });
    }
    return ok({ mapping, claims, spoof, data: executed.data });
  }, deps);
};
