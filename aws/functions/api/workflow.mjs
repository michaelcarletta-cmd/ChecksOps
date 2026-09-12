import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled, workflowFlagSnapshot } from './workflow-flags.mjs';
import { writesEnabled, checkWorkflowWritesEnabled, storageWritesEnabled } from './write-allowlist.mjs';
import { flagSnapshot } from './provider-flags.mjs';
import {
  evaluateTransition,
  INTERNAL_CREATE_STAGE,
  INTERNAL_CREATE_STATUS,
  isPartnerLinked,
  isTerminalFinancial,
  mapReviewPath,
  TRANSITIONS,
} from './workflow-transitions.mjs';
import { applyReverseTransitionCleanup } from './workflow-cleanup.mjs';
import { executeAdminOverride, withSavepoint } from './workflow-override.mjs';
import {
  evaluateEndorsementEligibility,
  loadCheckEndorsements,
  loadCheckPayees,
} from './providers/production/checkalt-eligibility.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRANSITION_ROLES = new Set(['staff', 'admin', 'owner', 'manager']);

const isUuid = (value) => UUID_RE.test(String(value || ''));

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
};

const asText = (value, max) => {
  const result = clip(value, max);
  if (result && result.error) return result;
  return { value: result };
};

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  applicationWorkflowWritesEnabled: applicationWorkflowWritesEnabled(),
  ...extra,
});

const okResult = ({ mapping, claims, spoof, data, extra = {} }) => ({
  ok: true,
  statusCode: 200,
  data,
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'rls',
  applicationWorkflowWritesEnabled: true,
  providerExecution: false,
  productionSupabaseChanged: false,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const deriveTenantId = (memberships, claimed) => {
  if (!memberships.length) {
    return { error: 'no_tenant_membership', message: 'Authenticated user has no tenant membership' };
  }
  if (claimed && isUuid(claimed) && memberships.some((row) => row.tenant_id === claimed)) {
    return { tenantId: claimed, usedClaimedMembership: true };
  }
  return { tenantId: memberships[0].tenant_id, usedClaimedMembership: false };
};

const rolesOf = async (client, userId, tenantId) => {
  const platform = (await client.query(USER_ROLES_SQL, [userId])).rows.map((row) => String(row.role || '').toLowerCase());
  const tenant = (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  return [...new Set([...platform, ...tenant])];
};

const canTransition = (roles) => roles.some((role) => TRANSITION_ROLES.has(role) || role === 'member');

const lookupWorkflowCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, uploaded_by, status, check_stage, claim_id, deposited_at,
            external_origin, partner_status, carrier_name, review_notes, amount
     FROM public.check_intake_items
     WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

const descriptiveFromBody = (body = {}) => {
  const out = {};
  for (const [column, max] of [
    ['carrier_name', 200],
    ['check_number', 80],
    ['payee_line', 2000],
    ['property_address', 2000],
    ['review_notes', 2000],
    ['payee_address', 2000],
    ['funds_type', 80],
  ]) {
    if (column in body) {
      const text = asText(body[column], max);
      if (text.error) return text;
      out[column] = text.value;
    }
  }
  if ('issue_date' in body) {
    if (body.issue_date === null || body.issue_date === '') out.issue_date = null;
    else if (!DATE_RE.test(String(body.issue_date))) return { error: 'invalid_field', field: 'issue_date' };
    else out.issue_date = String(body.issue_date);
  }
  if ('expiration_days' in body) {
    if (body.expiration_days === null || body.expiration_days === '') out.expiration_days = null;
    else {
      const n = Number(body.expiration_days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'invalid_field', field: 'expiration_days' };
      out.expiration_days = n;
    }
  }
  if ('is_multi_payee' in body) {
    if (body.is_multi_payee === true || body.is_multi_payee === 'true') out.is_multi_payee = true;
    else if (body.is_multi_payee === false || body.is_multi_payee === 'false') out.is_multi_payee = false;
    else if (body.is_multi_payee != null) return { error: 'invalid_field', field: 'is_multi_payee' };
  }
  if ('amount' in body && body.amount !== undefined && body.amount !== null && body.amount !== '') {
    const n = Number(body.amount);
    if (!Number.isFinite(n) || n < 0 || n > 50_000_000) return { error: 'invalid_field', field: 'amount' };
    out.amount = n;
  }
  return { values: out };
};

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

export const handleWorkflowStatus = async (event) => {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  return {
    ok: true,
    statusCode: 200,
    service: 'checksops-api',
    flags: {
      ...workflowFlagSnapshot(),
      AWS_WRITES_ENABLED: writesEnabled(),
      AWS_CHECK_WORKFLOW_WRITES_ENABLED: checkWorkflowWritesEnabled(),
      AWS_STORAGE_WRITES_ENABLED: storageWritesEnabled(),
      ...flagSnapshot(),
    },
    transitions: Object.values(TRANSITIONS).map((spec) => ({
      action: spec.action,
      fromStatus: spec.fromStatus,
      toStatus: spec.toStatus,
      toStage: spec.toStage,
      financialAuthorization: spec.financialAuthorization,
      providerExecution: spec.providerExecution,
    })),
    readyForProviderMeans: 'approved_for_deposit / ready_for_deposit — no CheckAlt or money movement',
    authenticated: Boolean(claims?.sub),
    productionSupabaseChanged: false,
    productionWebhooksRedirected: false,
  };
};

export const handleCreateCheck = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const memberships = await membershipsOf(client, mapping.application_user_id);
    const derived = deriveTenantId(memberships, body.tenant_id || body.tenantId);
    if (derived.error) return denied(spoof, { statusCode: 403, ...derived });
    const coerced = descriptiveFromBody(body);
    if (coerced.error) return denied(spoof, { statusCode: 400, ...coerced });
    const checkId = isUuid(body.id) ? String(body.id) : crypto.randomUUID();
    const placeholder = `checks/${checkId}/pending_front.jpg`;
    const values = coerced.values || {};
    const rows = (await client.query(
      `INSERT INTO public.check_intake_items (
         id, tenant_id, uploaded_by, status, check_stage, ocr_status,
         front_image_path, back_image_path, ocr_needs_verification,
         carrier_name, check_number, payee_line, property_address,
         funds_type, review_notes, payee_address, expiration_days,
         is_multi_payee, issue_date, amount
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::check_stage, 'pending',
         $6::text, NULL, false,
         $7::text, $8::text, $9::text, $10::text,
         $11::text, $12::text, $13::text, $14::int,
         $15::boolean, $16::date, $17::numeric
       ) RETURNING *`,
      [
        checkId,
        derived.tenantId,
        mapping.application_user_id,
        INTERNAL_CREATE_STATUS,
        INTERNAL_CREATE_STAGE,
        placeholder,
        values.carrier_name || null,
        values.check_number || null,
        values.payee_line || null,
        values.property_address || null,
        values.funds_type || null,
        values.review_notes || null,
        values.payee_address || null,
        values.expiration_days ?? null,
        values.is_multi_payee ?? null,
        values.issue_date || null,
        values.amount ?? null,
      ],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check insert blocked by RLS' });
    const created = rows[0];
    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'aws_workflow_created',
         'AWS staging created an internal check. OCR and provider submission were not invoked.',
         $4::jsonb
       )`,
      [
        created.id,
        created.tenant_id,
        mapping.application_user_id,
        JSON.stringify({
          image_prefix: `checks/${created.id}/`,
          ocr_invoked: false,
          provider_submitted: false,
          claim_id: null,
        }),
      ],
    );
    return okResult({
      mapping,
      claims,
      spoof,
      data: created,
      extra: {
        created: true,
        ocrInvoked: false,
        providerSubmitted: false,
        readyForProviderExecution: false,
        next: 'upload images to checks/{id}/ then run start_review',
        imagePrefix: `checks/${created.id}/`,
        tenantDerived: true,
        usedClaimedMembership: derived.usedClaimedMembership,
      },
    });
  }, deps);
};

export const handleCheckTransition = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    let action = String(body.action || body.transition || '').trim();
    if (!action && body.p_deposit_path) {
      const mapped = mapReviewPath(body.p_deposit_path);
      if (mapped.error) return denied(spoof, mapped);
      action = mapped.action;
    }
    if (!action) return denied(spoof, { statusCode: 400, error: 'missing_required_field', field: 'action' });
    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const looked = await lookupWorkflowCheck(client, checkId);
    if (looked.error) {
      return denied(spoof, { statusCode: looked.error === 'invalid_uuid' ? 400 : 403, ...looked });
    }
    const decided = evaluateTransition(action, looked.check);
    if (!decided.ok) {
      return denied(spoof, decided);
    }
    const roles = await rolesOf(client, mapping.application_user_id, looked.check.tenant_id);
    if (!canTransition(roles)) {
      return denied(spoof, { error: 'insufficient_role', message: 'Transition requires a tenant membership role' });
    }
    const notes = asText(body.review_notes || body.p_reviewer_notes, 2000);
    if (notes.error) return denied(spoof, { statusCode: 400, ...notes });
    if (action === 'mark_ready_for_deposit') {
      const payees = await loadCheckPayees(client, looked.check.id, looked.check.tenant_id);
      const endorsements = await loadCheckEndorsements(client, looked.check.id, looked.check.tenant_id);
      const endorsementGate = evaluateEndorsementEligibility(looked.check, payees, endorsements);
      if (!endorsementGate.ok) {
        return denied(spoof, {
          statusCode: 403,
          error: endorsementGate.error,
          reason: endorsementGate.reason,
          message: 'Ready for deposit requires a completed endorsement for every required payee.',
        });
      }
    }
    const rows = (await client.query(
      `UPDATE public.check_intake_items
       SET status = $2::text,
           check_stage = $3::check_stage,
           reviewed_by = $4::uuid,
           reviewed_at = now(),
           review_notes = COALESCE($5::text, review_notes),
           ocr_needs_verification = false,
           updated_at = now()
       WHERE id = $1::uuid
         AND claim_id IS NULL
         AND deposited_at IS NULL
       RETURNING *`,
      [looked.check.id, decided.nextStatus, decided.nextStage, mapping.application_user_id, notes.value],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not writable or no longer unlinked' });
    await withSavepoint(client, 'reverse_cleanup', async () => {
      await applyReverseTransitionCleanup(client, {
        checkId: looked.check.id,
        action,
        fromStatus: looked.check.status,
        fromStage: looked.check.check_stage,
        toStatus: decided.nextStatus,
        toStage: decided.nextStage,
        actorId: mapping.application_user_id,
      });
    });
    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'aws_workflow_transition',
         $4::text, $5::jsonb
       )`,
      [
        looked.check.id,
        looked.check.tenant_id,
        mapping.application_user_id,
        `AWS staging transition ${action}: ${looked.check.status} → ${decided.nextStatus}`,
        JSON.stringify({
          action,
          from_status: looked.check.status,
          to_status: decided.nextStatus,
          to_stage: decided.nextStage,
          provider_execution: false,
          ready_for_provider: decided.readyForProviderExecution,
        }),
      ],
    );
    return okResult({
      mapping,
      claims,
      spoof,
      data: rows[0],
      extra: {
        action,
        fromStatus: looked.check.status,
        toStatus: decided.nextStatus,
        toStage: decided.nextStage,
        readyForProviderExecution: decided.readyForProviderExecution,
        providerExecution: false,
        financialAuthorization: false,
      },
    });
  }, deps);
};

export const handleAdminOverride = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const looked = await lookupWorkflowCheck(client, checkId);
    if (looked.error) {
      return denied(spoof, { statusCode: looked.error === 'invalid_uuid' ? 400 : 403, ...looked });
    }
    const executed = await executeAdminOverride(client, {
      check: looked.check,
      mapping,
      destinationStatus: body.new_status || body.p_new_status || body.status,
      reason: body.reason || body.p_reason || body.review_notes,
    });
    if (!executed.ok) {
      return denied(spoof, { statusCode: executed.statusCode || 403, ...executed });
    }
    return okResult({
      mapping,
      claims,
      spoof,
      data: executed.data,
      extra: { providerExecution: false, financialAuthorization: false },
    });
  }, deps);
};

const deleteChildren = async (client, checkId) => {
  await client.query('DELETE FROM public.check_endorsement_events WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_endorsements WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_payees WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_messages WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_files WHERE check_intake_item_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_message_reads WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_audit_log WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.mortgage_handling_requests WHERE check_intake_item_id = $1::uuid', [checkId]);
  const drafts = (await client.query(
    'SELECT id FROM public.loss_draft_tracking WHERE check_intake_item_id = $1::uuid',
    [checkId],
  )).rows.map((row) => row.id);
  if (drafts.length) {
    await client.query('DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
    await client.query('DELETE FROM public.loss_draft_documents WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
    await client.query('DELETE FROM public.loss_draft_tracking WHERE id = ANY($1::uuid[])', [drafts]);
  }
  await client.query('DELETE FROM public.check_review_decisions WHERE check_id = $1::uuid', [checkId]);
};

export const handleDeleteCheck = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const checkId = body.check_id || body.checkId || body.id
      || String(event?.rawPath || '').split('/').filter(Boolean).pop();
    const looked = await lookupWorkflowCheck(client, checkId);
    if (looked.error) {
      return denied(spoof, { statusCode: looked.error === 'invalid_uuid' ? 400 : 403, ...looked });
    }
    if (looked.check.claim_id) {
      return denied(spoof, {
        error: 'cleanup_denied',
        message: 'Refusing to delete a claim-linked check',
      });
    }
    if (isPartnerLinked(looked.check) || isTerminalFinancial(looked.check)) {
      return denied(spoof, {
        error: 'cleanup_denied',
        message: 'Refusing to delete a partner-linked or deposited check',
      });
    }
    await deleteChildren(client, looked.check.id);
    const rows = (await client.query(
      'DELETE FROM public.check_intake_items WHERE id = $1::uuid AND claim_id IS NULL RETURNING id',
      [looked.check.id],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not deletable' });
    return okResult({
      mapping,
      claims,
      spoof,
      data: { id: looked.check.id, deleted: true },
      extra: { cleanedUp: true },
    });
  }, deps);
};

export const matchWorkflowRoute = (method, path) => {
  if (method === 'GET' && path === '/workflow/status') return 'status';
  if (method === 'POST' && path === '/workflow/checks') return 'create';
  if (method === 'POST' && (path === '/workflow/override' || path === '/workflow/checks/override')) return 'override';
  if (method === 'POST' && (path === '/workflow/transition' || path === '/workflow/checks/transition')) return 'transition';
  const transition = path.match(/^\/workflow\/checks\/([^/]+)\/transition$/);
  if (method === 'POST' && transition) return { kind: 'transition', checkId: decodeURIComponent(transition[1]) };
  const remove = path.match(/^\/workflow\/checks\/([^/]+)$/);
  if (method === 'DELETE' && remove) return { kind: 'delete', checkId: decodeURIComponent(remove[1]) };
  return null;
};

export const handleWorkflowRequest = async (event, path, method, deps = {}) => {
  const match = matchWorkflowRoute(method, path);
  if (!match) return null;
  if (match === 'status') return handleWorkflowStatus(event);
  if (match === 'create') return handleCreateCheck(event, deps);
  if (match === 'override') return handleAdminOverride(event, deps);
  if (match === 'transition') return handleCheckTransition(event, deps);
  if (match.kind === 'transition') {
    const body = parseBody(event);
    event = { ...event, body: JSON.stringify({ ...body, check_id: body.check_id || match.checkId }) };
    return handleCheckTransition(event, deps);
  }
  if (match.kind === 'delete') {
    const body = parseBody(event);
    event = { ...event, body: JSON.stringify({ ...body, check_id: body.check_id || match.checkId }) };
    return handleDeleteCheck(event, deps);
  }
  return null;
};
