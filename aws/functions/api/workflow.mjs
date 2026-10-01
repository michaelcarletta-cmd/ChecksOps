import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled, workflowFlagSnapshot } from './workflow-flags.mjs';
import { writesEnabled, checkWorkflowWritesEnabled, storageWritesEnabled } from './write-allowlist.mjs';
import { flagSnapshot } from './provider-flags.mjs';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  evaluateTransition,
  INTERNAL_CREATE_STAGE,
  INTERNAL_CREATE_STATUS,
  isPartnerLinked,
  isTerminalFinancial,
  mapReviewPath,
  TRANSITIONS,
} from './workflow-transitions.mjs';
import {
  evaluateEndorsementEligibility,
  loadCheckEndorsements,
  loadCheckPayees,
} from './providers/production/checkalt-eligibility.mjs';
import { isCheckScopedPathFor, normalizePath, s3KeyFor } from './storage-paths.mjs';

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

const filesBucket = () => process.env.FILES_BUCKET || '';
const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });

const MAX_CHECK_DELETE_KEYS = 2000;

const listKeysByPrefix = async (deps, prefix) => {
  const s3 = defaultS3(deps);
  const bucket = filesBucket();
  if (!bucket) {
    const error = new Error('s3_not_configured');
    error.name = 'S3NotConfigured';
    throw error;
  }
  const keys = [];
  let token = undefined;
  while (true) {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of out.Contents || []) {
      if (obj?.Key) keys.push(obj.Key);
      if (keys.length > MAX_CHECK_DELETE_KEYS) {
        const error = new Error('too_many_objects');
        error.name = 'TooManyObjects';
        error.prefix = prefix;
        error.count = keys.length;
        throw error;
      }
    }
    if (!out.IsTruncated) break;
    token = out.NextContinuationToken;
    if (!token) break;
  }
  return keys;
};

const deleteKeys = async (deps, keys) => {
  const s3 = defaultS3(deps);
  const bucket = filesBucket();
  if (!bucket) {
    return { ok: false, error: 's3_not_configured' };
  }
  const errors = [];
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const out = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Quiet: true,
        Objects: batch.map((Key) => ({ Key })),
      },
    }));
    deleted += (out.Deleted || []).length;
    for (const err of out.Errors || []) {
      errors.push({
        key: err.Key || null,
        code: err.Code || null,
        message: err.Message || null,
      });
    }
    if (errors.length) break;
  }
  if (errors.length) return { ok: false, error: 'storage_delete_failed', deleted, errors };
  return { ok: true, deleted, errors: [] };
};

const collectCheckOwnedStorageKeys = async (client, checkId) => {
  const row = (await client.query(
    `SELECT id, tenant_id,
            front_image_path, back_image_path, back_image_original_path, back_image_deposit_path,
            endorsement_packet_path
       FROM public.check_intake_items
      WHERE id = $1::uuid
      LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { error: 'rls_denied', message: 'check not found or not writable' };

  const tenantId = row.tenant_id;
  const keys = new Set();
  const meta = [];

  const addClaimFilesPath = (value, source) => {
    const rel = normalizePath(value, 'claim-files');
    if (!rel) return;
    if (!isCheckScopedPathFor(rel, checkId)) return;
    const key = s3KeyFor('claim-files', rel);
    if (!key) return;
    keys.add(key);
    meta.push({ bucket: 'claim-files', rel, source });
  };

  addClaimFilesPath(row.front_image_path, 'check_intake_items.front_image_path');
  addClaimFilesPath(row.back_image_path, 'check_intake_items.back_image_path');
  addClaimFilesPath(row.back_image_original_path, 'check_intake_items.back_image_original_path');
  addClaimFilesPath(row.back_image_deposit_path, 'check_intake_items.back_image_deposit_path');

  const fileRows = (await client.query(
    'SELECT file_path FROM public.check_files WHERE check_intake_item_id = $1::uuid',
    [checkId],
  )).rows;
  for (const f of fileRows) addClaimFilesPath(f.file_path, 'check_files.file_path');

  const payeeRows = (await client.query(
    'SELECT endorsement_image_path FROM public.check_payees WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const p of payeeRows) addClaimFilesPath(p.endorsement_image_path, 'check_payees.endorsement_image_path');

  const endorsementRows = (await client.query(
    'SELECT signature_image_url FROM public.check_endorsements WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const e of endorsementRows) addClaimFilesPath(e.signature_image_url, 'check_endorsements.signature_image_url');

  const lossDraftIds = (await client.query(
    'SELECT id FROM public.loss_draft_tracking WHERE check_intake_item_id = $1::uuid',
    [checkId],
  )).rows.map((r) => r.id).filter(Boolean);
  if (lossDraftIds.length) {
    const docs = (await client.query(
      'SELECT file_path FROM public.loss_draft_documents WHERE loss_draft_id = ANY($1::uuid[])',
      [lossDraftIds],
    )).rows;
    for (const d of docs) {
      const rel = normalizePath(d.file_path, 'loss-draft-documents');
      if (!rel) continue;
      const key = s3KeyFor('loss-draft-documents', rel);
      if (!key) continue;
      keys.add(key);
      meta.push({ bucket: 'loss-draft-documents', rel, source: 'loss_draft_documents.file_path' });
    }
  }

  const packetRaw = row.endorsement_packet_path;
  if (packetRaw && tenantId) {
    const tenantLower = String(tenantId).toLowerCase();
    const idLower = String(checkId).toLowerCase();

    const relClaim = normalizePath(packetRaw, 'claim-files');
    if (relClaim && String(relClaim).toLowerCase().startsWith(`endorsement-packets/${tenantLower}/${idLower}/`)) {
      const key = s3KeyFor('claim-files', relClaim);
      if (key) {
        keys.add(key);
        meta.push({ bucket: 'claim-files', rel: relClaim, source: 'check_intake_items.endorsement_packet_path' });
      }
    }

    const relPackets = normalizePath(packetRaw, 'endorsement-packets');
    if (relPackets && String(relPackets).toLowerCase().startsWith(`${tenantLower}/${idLower}/`)) {
      const key = s3KeyFor('endorsement-packets', relPackets);
      if (key) {
        keys.add(key);
        meta.push({ bucket: 'endorsement-packets', rel: relPackets, source: 'check_intake_items.endorsement_packet_path' });
      }
    }
  }

  return { tenantId, keys: [...keys], meta };
};

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

const platformRolesOf = async (client, userId) => {
  const rows = (await client.query(USER_ROLES_SQL, [userId])).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()).filter(Boolean));
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
      data: { ...rows[0], new_stage: rows[0].check_stage },
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

  let plannedStorageKeys = [];
  let plannedStorageKeyCount = 0;
  let plannedStorageKeySample = [];

  const result = await withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const roles = await platformRolesOf(client, mapping.application_user_id);
    if (!roles.has('admin')) {
      return denied(spoof, { error: 'not_authorized', message: 'Only admins can delete checks' });
    }
    const checkId = body.check_id || body.checkId || body.id
      || String(event?.rawPath || '').split('/').filter(Boolean).pop();
    const reason = clip(body.reason || body.p_reason || body.delete_reason, 2000);
    if (reason && reason.error) {
      return denied(spoof, { statusCode: 400, ...reason });
    }
    if (!reason || String(reason).length < 3) {
      return denied(spoof, { statusCode: 400, error: 'missing_required_field', field: 'reason', message: 'A deletion reason (min 3 characters) is required' });
    }
    const looked = await lookupWorkflowCheck(client, checkId);
    if (looked.error) {
      return denied(spoof, { statusCode: looked.error === 'invalid_uuid' ? 400 : 403, ...looked });
    }
    if (isPartnerLinked(looked.check)) {
      return denied(spoof, {
        error: 'check_shared_with_partner',
        message: 'This check cannot be deleted because it is shared with a partner.',
      });
    }
    if (isTerminalFinancial(looked.check)) {
      return denied(spoof, {
        error: 'check_terminal_financial_state',
        message: 'This check cannot be deleted because it has already reached a terminal financial state (e.g. deposited or released).',
      });
    }

    const blockers = [
      { table: 'deposit_items', sql: 'SELECT 1 FROM public.deposit_items WHERE check_id = $1::uuid LIMIT 1' },
      { table: 'checkalt_deposits', sql: 'SELECT 1 FROM public.checkalt_deposits WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'disbursement_batches', sql: 'SELECT 1 FROM public.disbursement_batches WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'claim_check_payments', sql: 'SELECT 1 FROM public.claim_check_payments WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'claim_payments', sql: 'SELECT 1 FROM public.claim_payments WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'check_billing_events', sql: 'SELECT 1 FROM public.check_billing_events WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'check_payment_directions', sql: `SELECT 1
          FROM public.check_payment_directions d
          JOIN public.claim_checks cc ON cc.id = d.check_id
         WHERE cc.check_intake_item_id = $1::uuid
         LIMIT 1` },
      { table: 'claim_disbursements', sql: `SELECT 1
          FROM public.claim_disbursements cd
          JOIN public.claim_checks cc ON cc.id = cd.check_id
         WHERE cc.check_intake_item_id = $1::uuid
         LIMIT 1` },
      { table: 'claim_checks_terminal', sql: `SELECT 1
          FROM public.claim_checks cc
         WHERE cc.check_intake_item_id = $1::uuid
           AND lower(coalesce(cc.deposit_status::text, '')) IN ('deposited','cleared','settled')
         LIMIT 1` },
    ];
    for (const [idx, blocker] of blockers.entries()) {
      const savepoint = `delete_blocker_${idx}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const rows = (await client.query(blocker.sql, [looked.check.id])).rows;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (rows.length) {
          return denied(spoof, {
            error: 'check_has_financial_activity',
            message: `This check cannot be deleted because it has dependent financial/provider records (${blocker.table}).`,
            blocker: blocker.table,
          });
        }
      } catch (error) {
        try { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* ignore */ }
        try { await client.query(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* ignore */ }
        if (error?.code === '42P01') continue;
        if (error?.code === '42501') {
          return denied(spoof, {
            error: 'blocker_verification_denied',
            message: `This check cannot be deleted because the service cannot verify financial/provider blockers (${blocker.table}).`,
            blocker: blocker.table,
          });
        }
        throw error;
      }
    }

    if (deps.disableS3Cleanup !== true) {
      const storageEnabled = deps.forceStorageWrites === true || storageWritesEnabled();
      if (!storageEnabled) {
        return denied(spoof, {
          statusCode: 403,
          error: 'storage_writes_disabled',
          message: 'Refusing to delete: storage deletes are disabled by AWS_STORAGE_WRITES_ENABLED',
        });
      }
      if (!filesBucket()) {
        return denied(spoof, {
          statusCode: 503,
          error: 's3_not_configured',
          message: 'Refusing to delete: FILES_BUCKET is not configured',
        });
      }

      const collected = await collectCheckOwnedStorageKeys(client, looked.check.id);
      if (collected.error) {
        return denied(spoof, { statusCode: 403, ...collected });
      }

      const keySet = new Set(collected.keys);
      const checkIdText = String(looked.check.id);

      for (const relPrefix of [
        `checks/${checkIdText}/`,
        `checks/reupload/${checkIdText}/`,
        `check-intake/${checkIdText}/files/`,
      ]) {
        const prefixKey = `files/claim-files/${relPrefix}`;
        const found = await listKeysByPrefix(deps, prefixKey);
        for (const k of found) {
          const rel = String(k).replace(/^files\/claim-files\//, '');
          if (!isCheckScopedPathFor(rel, looked.check.id)) continue;
          keySet.add(k);
        }
      }

      if (collected.tenantId) {
        const tenantId = String(collected.tenantId);
        for (const prefixKey of [
          `files/claim-files/endorsement-packets/${tenantId}/${checkIdText}/`,
          `files/endorsement-packets/${tenantId}/${checkIdText}/`,
        ]) {
          const found = await listKeysByPrefix(deps, prefixKey);
          for (const k of found) {
            if (prefixKey.startsWith('files/claim-files/')) {
              const rel = String(k).replace(/^files\/claim-files\//, '');
              if (!String(rel).toLowerCase().startsWith(`endorsement-packets/${tenantId.toLowerCase()}/${checkIdText.toLowerCase()}/`)) continue;
            } else if (prefixKey.startsWith('files/endorsement-packets/')) {
              const rel = String(k).replace(/^files\/endorsement-packets\//, '');
              if (!String(rel).toLowerCase().startsWith(`${tenantId.toLowerCase()}/${checkIdText.toLowerCase()}/`)) continue;
            }
            keySet.add(k);
          }
        }
      }

      plannedStorageKeys = [...keySet];
      plannedStorageKeyCount = plannedStorageKeys.length;
      plannedStorageKeySample = plannedStorageKeys.slice(0, 50);
    }

    let auditSavepointHeld = false;
    await client.query('SAVEPOINT delete_audit_snapshot');
    auditSavepointHeld = true;
    try {
      const exists = (await client.query("SELECT to_regclass('public.check_deletion_log') AS t")).rows[0]?.t;
      if (exists) {
        const row = (await client.query('SELECT * FROM public.check_intake_items WHERE id = $1::uuid', [looked.check.id])).rows[0];
        if (row) {
          await client.query(
            `INSERT INTO public.check_deletion_log
              (check_id, claim_id, check_number, amount, status, reason, deleted_by, snapshot)
             VALUES ($1::uuid, $2::uuid, $3::text, $4::numeric, $5::text, $6::text, $7::uuid, $8::jsonb)`,
            [
              looked.check.id,
              row.claim_id ?? null,
              row.check_number ?? null,
              row.amount ?? null,
              row.status ?? null,
              String(reason),
              mapping.application_user_id,
              JSON.stringify(row),
            ],
          );
        }
      }
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      auditSavepointHeld = false;
    }

    let rows = [];
    await client.query('SAVEPOINT delete_check_attempt');
    try {
      rows = (await client.query(
        'DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id',
        [looked.check.id],
      )).rows;
      await client.query('RELEASE SAVEPOINT delete_check_attempt');
    } catch (error) {
      try { await client.query('ROLLBACK TO SAVEPOINT delete_check_attempt'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_check_attempt'); } catch { /* ignore */ }
      if (error?.code !== '23503') throw error;

      await client.query('SAVEPOINT delete_claim_links');
      try {
        await client.query('DELETE FROM public.claim_checks WHERE check_intake_item_id = $1::uuid', [looked.check.id]);
        await client.query('UPDATE public.loss_draft_tracking SET check_intake_item_id = NULL WHERE check_intake_item_id = $1::uuid', [looked.check.id]);
        await client.query('RELEASE SAVEPOINT delete_claim_links');
      } catch (cleanupError) {
        try { await client.query('ROLLBACK TO SAVEPOINT delete_claim_links'); } catch { /* ignore */ }
        try { await client.query('RELEASE SAVEPOINT delete_claim_links'); } catch { /* ignore */ }
        if (cleanupError?.code === '42P01' || cleanupError?.code === '42703') {
          // schema mismatch: ignore and proceed
        } else if (cleanupError?.code === '42501') {
          if (auditSavepointHeld) {
            try { await client.query('ROLLBACK TO SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
            try { await client.query('RELEASE SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
            auditSavepointHeld = false;
          }
          try {
            const out = await client.query(
              'SELECT public.admin_delete_check($1::uuid, $2::uuid, $3::text) AS result',
              [looked.check.id, mapping.application_user_id, String(reason)],
            );
            const res = out.rows?.[0]?.result || {};
            const success = res?.success === true || res?.success === 'true';
            if (!success) {
              return denied(spoof, {
                error: 'cleanup_denied',
                message: 'This check cannot be deleted because dependent claim/escrow links could not be cleaned up.',
              });
            }
            return okResult({
              mapping,
              claims,
              spoof,
              data: { id: looked.check.id, deleted: true },
              extra: {
                cleanedUp: true,
                usedAdminDeleteCheck: true,
                storageCleanup: deps.disableS3Cleanup === true
                  ? { ok: true, deleted: 0, skipped: true }
                  : { ok: true, deleted: 0, skipped: plannedStorageKeyCount === 0, planned: plannedStorageKeyCount, plannedSample: plannedStorageKeySample },
              },
            });
          } catch (fallbackError) {
            if (fallbackError?.code === '42P01' || fallbackError?.code === '42883') {
              return denied(spoof, {
                error: 'cleanup_denied',
                message: 'This check cannot be deleted because dependent claim/escrow links could not be cleaned up.',
              });
            }
            throw fallbackError;
          }
        } else {
          throw cleanupError;
        }
      }

      rows = (await client.query(
        'DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id',
        [looked.check.id],
      )).rows;
    }

    if (auditSavepointHeld) {
      try { await client.query('RELEASE SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      auditSavepointHeld = false;
    }
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not deletable' });
    return okResult({
      mapping,
      claims,
      spoof,
      data: { id: looked.check.id, deleted: true },
      extra: {
        cleanedUp: true,
        storageCleanup: deps.disableS3Cleanup === true
          ? { ok: true, deleted: 0, skipped: true }
          : { ok: true, deleted: 0, skipped: plannedStorageKeyCount === 0, planned: plannedStorageKeyCount, plannedSample: plannedStorageKeySample },
      },
    });
  }, deps);

  // After DB commit, attempt S3 deletion. Never delete S3 objects unless the DB deletion succeeded.
  if (!result?.ok || deps.disableS3Cleanup === true) return result;
  if (!plannedStorageKeys.length) {
    result.storageCleanup = { ok: true, deleted: 0, skipped: true };
    return result;
  }

  try {
    const deleted = await deleteKeys(deps, plannedStorageKeys);
    if (!deleted.ok) {
      console.error(JSON.stringify({
        service: 'checksops-api',
        event: 'check_delete_storage_cleanup_failed',
        checkId: result?.data?.id || null,
        error: deleted.error || 'storage_delete_failed',
        deletedCount: deleted.deleted || 0,
        errorCount: (deleted.errors || []).length,
        sampleErrors: (deleted.errors || []).slice(0, 10),
      }));
      result.storageCleanup = {
        ok: false,
        error: deleted.error || 'storage_delete_failed',
        deleted: deleted.deleted || 0,
        errors: (deleted.errors || []).slice(0, 10),
        attempted: Math.min(plannedStorageKeys.length, 50),
      };
      return result;
    }
    result.storageCleanup = { ok: true, deleted: deleted.deleted || 0, skipped: false };
    return result;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 240);
    console.error(JSON.stringify({
      service: 'checksops-api',
      event: 'check_delete_storage_cleanup_failed',
      checkId: result?.data?.id || null,
      error: 'storage_delete_failed',
      message,
    }));
    result.storageCleanup = { ok: false, error: 'storage_delete_failed', message };
    return result;
  }
};

const looksGeneratedBack = (p) =>
  !!p && (
    /_endorsed(?:_\d+)?\.[^.]+$/i.test(String(p)) ||
    /endorsed_deposit_[^/]+\.[^.]+$/i.test(String(p)) ||
    /\.svg(\?|$)/i.test(String(p)) ||
    /\.checkalt\.jpg(\?|$)/i.test(String(p))
  );

/**
 * Staging-only operator reset for endorsement render pointers.
 *
 * Narrowly scoped to McGurrin #9562:
 * - verifies caller has transition role (admin/staff/member)
 * - verifies check_number == 9562
 * - preserves back_image_path + back_image_original_path
 * - resets only back_image_deposit_path + endorsement_render_status + endorsement_render_meta
 * - reports before/after
 */
export const handleEndorsementRenderReset = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const checkId = body.check_id || body.checkId || body.id;
    if (!isUuid(checkId)) {
      return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'check_id' });
    }
    const rows = (await client.query(
      `SELECT id, tenant_id, check_number,
              back_image_path, back_image_original_path, back_image_deposit_path,
              endorsement_render_status, endorsement_render_meta
         FROM public.check_intake_items
        WHERE id = $1::uuid`,
      [checkId],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not found or not writable' });
    const before = rows[0];
    if (String(before.check_number || '') !== '9562') {
      return denied(spoof, { statusCode: 403, error: 'reset_scope_denied', message: 'Reset operator is restricted to McGurrin #9562' });
    }
    const roles = await rolesOf(client, mapping.application_user_id, before.tenant_id);
    if (!canTransition(roles)) {
      return denied(spoof, { error: 'insufficient_role', message: 'Reset requires a tenant membership role' });
    }
    if (!before.back_image_original_path || looksGeneratedBack(before.back_image_original_path)) {
      return denied(spoof, { statusCode: 409, error: 'precondition_failed', message: 'back_image_original_path is missing or points to a generated artifact' });
    }
    if (before.back_image_deposit_path && !looksGeneratedBack(before.back_image_deposit_path)) {
      return denied(spoof, { statusCode: 409, error: 'precondition_failed', message: 'back_image_deposit_path is not a recognized generated artifact' });
    }

    const afterRows = (await client.query(
      `UPDATE public.check_intake_items
          SET back_image_deposit_path = NULL,
              endorsement_render_status = 'idle',
              endorsement_render_meta = NULL,
              updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, tenant_id, check_number,
                  back_image_path, back_image_original_path, back_image_deposit_path,
                  endorsement_render_status, endorsement_render_meta`,
      [checkId],
    )).rows;
    if (!afterRows.length) return denied(spoof, { error: 'rls_denied', message: 'reset blocked by RLS' });
    const after = afterRows[0];

    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'aws_endorsement_render_reset',
         'AWS staging reset endorsement render pointers (deposit path + render status/meta only).',
         $4::jsonb
       )`,
      [
        after.id,
        after.tenant_id,
        mapping.application_user_id,
        JSON.stringify({
          check_number: after.check_number ?? null,
          before: {
            back_image_deposit_path: before.back_image_deposit_path ?? null,
            endorsement_render_status: before.endorsement_render_status ?? null,
          },
          after: {
            back_image_deposit_path: after.back_image_deposit_path ?? null,
            endorsement_render_status: after.endorsement_render_status ?? null,
          },
        }),
      ],
    );

    return okResult({
      mapping,
      claims,
      spoof,
      data: after,
      extra: { before, after, reset: true },
    });
  }, deps);
};

export const matchWorkflowRoute = (method, path) => {
  if (method === 'GET' && path === '/workflow/status') return 'status';
  if (method === 'POST' && path === '/workflow/checks') return 'create';
  if (method === 'POST' && (path === '/workflow/transition' || path === '/workflow/checks/transition')) return 'transition';
  if (method === 'POST' && path === '/workflow/endorsement-render-reset') return 'endorsement-render-reset';
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
  if (match === 'transition') return handleCheckTransition(event, deps);
  if (match === 'endorsement-render-reset') return handleEndorsementRenderReset(event, deps);
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
