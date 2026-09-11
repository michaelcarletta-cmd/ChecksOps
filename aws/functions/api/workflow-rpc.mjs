/**
 * Safe non-financial write RPC bridges for AWS staging.
 *
 * Calls replicate SECURITY DEFINER semantics under Cognito → request.app_user_id → auth.uid(),
 * without GRANT EXECUTE on production DEFINER functions and without provider/financial side effects.
 *
 * Classification for every rpc_disabled name lives in SAFE_WRITE_RPC_CLASSIFICATION.
 */
import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';
import { writesEnabled } from './write-allowlist.mjs';
import { executeAdminOverride } from './workflow-override.mjs';

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
  deposit_action: 'financial_sensitive',
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
  'admin_override_check_status',
  'record_check_return',
  'resolve_check_return',
]);

const SESSION_RPCS = new Set(['register_session', 'validate_session', 'invalidate_session', 'log_audit']);

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
  const restoreStage = check.pre_return_stage || 'review';
  const resolution = arg(args, 'p_resolution') == null ? 'resolved' : String(arg(args, 'p_resolution')).slice(0, 120);
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
      JSON.stringify({ restored_stage: restoreStage, resolution, provider_execution: false }),
    ],
  );
  return { data: { ok: true, check_id: checkId, restored_stage: restoreStage } };
};

const executeAdminOverrideRpc = async ({ client, mapping, args }) => {
  const checkId = arg(args, 'p_check_id', 'check_id');
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'p_check_id' };
  const check = (await client.query(
    `SELECT id, tenant_id, uploaded_by, status, check_stage, claim_id, deposited_at,
            external_origin, partner_status, carrier_name, review_notes, amount
     FROM public.check_intake_items WHERE id = $1::uuid`,
    [checkId],
  )).rows[0];
  if (!check) return { error: 'rls_denied', message: 'Check not found' };
  return executeAdminOverride(client, {
    check,
    mapping,
    destinationStatus: arg(args, 'p_new_status', 'new_status'),
    reason: arg(args, 'p_reason', 'reason', 'p_review_notes'),
  }).then((executed) => (executed?.ok ? { data: executed.data } : executed));
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
    case 'admin_override_check_status':
      return executeAdminOverrideRpc({ client, mapping, args });
    case 'record_check_return':
      return executeRecordCheckReturn({ client, mapping, args });
    case 'resolve_check_return':
      return executeResolveCheckReturn({ client, mapping, args });
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
  if (!SAFE_WRITE_RPCS.has(name)) {
    return denied(spoof, { error: 'rpc_disabled', name });
  }

  const sessionLike = SESSION_RPCS.has(name);
  const enabled = deps.forceEnabled === true
    || (sessionLike ? writesEnabled() : applicationWorkflowWritesEnabled());
  if (!enabled) {
    return withIdentity(event, async () => denied(spoof, {
      error: sessionLike ? 'writes_disabled' : 'application_workflow_writes_disabled',
      message: sessionLike
        ? 'AWS writes are disabled by AWS_WRITES_ENABLED'
        : 'Application-workflow writes are disabled by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
      name,
    }), deps);
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
        || executed.error === 'invalid_destination'
        || executed.error === 'reason_required'
        ? 400
        : 403;
      return denied(spoof, { statusCode: status, name, ...executed });
    }
    return ok({ mapping, claims, spoof, data: executed.data });
  }, deps);
};
