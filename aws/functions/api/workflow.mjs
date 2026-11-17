import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled, workflowFlagSnapshot } from './workflow-flags.mjs';
import { writesEnabled, checkWorkflowWritesEnabled, storageWritesEnabled } from './write-allowlist.mjs';
import { flagSnapshot } from './provider-flags.mjs';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  evaluateTransition,
  INTERNAL_CREATE_STAGE,
  INTERNAL_CREATE_STATUS,
  isTerminalFinancial,
  mapReviewPath,
  TRANSITIONS,
  TENANT_MEMBER_SQL,
} from './workflow-transitions.mjs';
import {
  evaluateEndorsementEligibility,
  loadCheckEndorsements,
  loadCheckPayees,
} from './providers/production/checkalt-eligibility.mjs';
import { isCheckScopedPathFor, normalizePath, s3KeyFor } from './storage-paths.mjs';
import { setMoneyWriteFlag } from './money-write-flag.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  // Check intake images and known render artifacts stored under check-scoped prefixes.
  addClaimFilesPath(row.front_image_path, 'check_intake_items.front_image_path');
  addClaimFilesPath(row.back_image_path, 'check_intake_items.back_image_path');
  addClaimFilesPath(row.back_image_original_path, 'check_intake_items.back_image_original_path');
  addClaimFilesPath(row.back_image_deposit_path, 'check_intake_items.back_image_deposit_path');

  // Files uploaded for the check (metadata table does not store bucket; these are claim-files by design).
  const fileRows = (await client.query(
    'SELECT file_path FROM public.check_files WHERE check_intake_item_id = $1::uuid',
    [checkId],
  )).rows;
  for (const f of fileRows) addClaimFilesPath(f.file_path, 'check_files.file_path');

  // Payee endorsement images (if present).
  const payeeRows = (await client.query(
    'SELECT endorsement_image_path FROM public.check_payees WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const p of payeeRows) addClaimFilesPath(p.endorsement_image_path, 'check_payees.endorsement_image_path');

  // Endorsement signature images (if stored as claim-files object paths or URLs).
  const endorsementRows = (await client.query(
    'SELECT signature_image_url FROM public.check_endorsements WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const e of endorsementRows) addClaimFilesPath(e.signature_image_url, 'check_endorsements.signature_image_url');

  // Loss-draft documents linked via loss_draft_tracking → loss_draft_documents (check-owned).
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

  // Endorsement packets referenced by the check. Stored under an endorsement-packets prefix.
  const packetRaw = row.endorsement_packet_path;
  if (packetRaw && tenantId) {
    const tenantLower = String(tenantId).toLowerCase();
    const idLower = String(checkId).toLowerCase();

    // In some environments this is stored in the claim-files map under an endorsement-packets/ prefix.
    const relClaim = normalizePath(packetRaw, 'claim-files');
    if (relClaim && String(relClaim).toLowerCase().startsWith(`endorsement-packets/${tenantLower}/${idLower}`)) {
      const key = s3KeyFor('claim-files', relClaim);
      if (key) {
        keys.add(key);
        meta.push({ bucket: 'claim-files', rel: relClaim, source: 'check_intake_items.endorsement_packet_path' });
      }
    }

    // Also attempt the dedicated endorsement-packets map (prefix stripped by normalizePath).
    const relPackets = normalizePath(packetRaw, 'endorsement-packets');
    if (relPackets && String(relPackets).toLowerCase().startsWith(`${tenantLower}/${idLower}`)) {
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

// Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
// Only the caller's own tenant_users row for the check's tenant counts (the role
// column is ignored). Platform user_roles (admin/staff) are not read.
const isTenantMember = async (client, userId, tenantId) => {
  if (!isUuid(tenantId)) return false;
  return (await client.query(TENANT_MEMBER_SQL, [userId, tenantId])).rows.length > 0;
};

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

// Transitions that move a check out of Review. A check filed from a homeowner's pre-claim upload
// must carry a claim by then, so the homeowner's link can follow the claim from here on.
const HOMEOWNER_CLAIM_LINK_ACTIONS = new Set(['start_endorsing', 'route_loss_draft', 'mark_ready_for_deposit']);

const loadHomeownerUploadForCheck = async (client, check) => (await client.query(
  `SELECT id, token_id, claim_id, amount_estimate
   FROM public.homeowner_ledger_check_uploads
   WHERE attached_check_id = $1::uuid AND tenant_id = $2::uuid
   LIMIT 1`,
  [check.id, check.tenant_id],
)).rows[0] || null;

// Mirrors the manual attach in homeowner.mjs: the homeowner's link joins the claim and the
// timeline records it. Runs once per upload; a link already on a claim is never moved.
const linkHomeownerUploadToClaim = async (client, upload, check) => {
  if (upload.claim_id) return;
  const claim = (await client.query(
    `SELECT id, claim_number FROM public.claims WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`,
    [check.claim_id, check.tenant_id],
  )).rows[0];
  if (!claim) return;
  const marked = (await client.query(
    `UPDATE public.homeowner_ledger_check_uploads
     SET claim_id = $2::uuid
     WHERE id = $1::uuid AND claim_id IS NULL
     RETURNING id`,
    [upload.id, claim.id],
  )).rows;
  if (!marked.length) return;
  if (upload.token_id) {
    await client.query(
      `UPDATE public.homeowner_ledger_tokens
       SET claim_id = $2::uuid
       WHERE id = $1::uuid AND tenant_id = $3::uuid AND claim_id IS NULL`,
      [upload.token_id, claim.id, check.tenant_id],
    );
  }
  await client.query(
    `INSERT INTO public.homeowner_ledger_events (
       tenant_id, claim_id, event_type, amount, actor_label, payload_json
     ) VALUES ($1::uuid, $2::uuid, 'homeowner_upload_attached', $3, 'Staff', $4::jsonb)`,
    [
      check.tenant_id,
      claim.id,
      check.amount ?? upload.amount_estimate ?? null,
      JSON.stringify({ upload_id: upload.id, check_id: check.id, claim_number: claim.claim_number }),
    ],
  );
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

// A check created from a Cash Job carries the job's link; a check uploaded from
// the Command Center may carry the claim picked at upload. Both are verified
// against the tenant the check is created in; nothing the client sends is
// written without that check. check_source and cash_job_payment_class are set
// here, server-side (the generic write path keeps them prohibited).
export const CASH_JOB_PAYMENT_CLASSES = Object.freeze([
  'initial_deposit', 'final_payment', 'progress_payment', 'other',
]);

export const CLAIM_IN_TENANT_SQL = `SELECT 1 FROM public.claims c
     WHERE c.id = $1::uuid
       AND (c.org_id = $2::uuid
         OR (c.org_id IS NULL AND EXISTS (SELECT 1 FROM public.check_intake_items ci
                    WHERE ci.claim_id = c.id AND ci.tenant_id = $2::uuid)))
     LIMIT 1`;

export const CASH_JOB_IN_TENANT_SQL = `SELECT id, tenant_id, job_name FROM public.cash_jobs
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`;

const blankLink = (value) => value === undefined || value === null || value === '';

export const resolveCreateLinks = async (client, tenantId, body = {}) => {
  const rawClaim = body.claim_id ?? body.claimId;
  const rawJob = body.cash_job_id ?? body.cashJobId;
  const rawClass = body.cash_job_payment_class ?? body.cashJobPaymentClass;
  const links = { claimId: null, cashJobId: null, cashJobName: null, paymentClass: null };
  if (!blankLink(rawClaim) && !blankLink(rawJob)) {
    return { statusCode: 400, error: 'invalid_field', field: 'claim_id', message: 'A check links to a claim or a cash job, not both' };
  }
  if (!blankLink(rawClass) && blankLink(rawJob)) {
    return { statusCode: 400, error: 'invalid_field', field: 'cash_job_payment_class' };
  }
  if (!blankLink(rawClaim)) {
    if (!isUuid(rawClaim)) return { statusCode: 400, error: 'invalid_uuid', field: 'claim_id' };
    const owned = (await client.query(CLAIM_IN_TENANT_SQL, [String(rawClaim), tenantId])).rows;
    if (!owned.length) {
      return { statusCode: 403, error: 'claim_not_in_tenant', message: 'The claim is not in this tenant' };
    }
    links.claimId = String(rawClaim);
  }
  if (!blankLink(rawJob)) {
    if (!isUuid(rawJob)) return { statusCode: 400, error: 'invalid_uuid', field: 'cash_job_id' };
    const jobId = String(rawJob).toLowerCase();
    const jobs = (await client.query(CASH_JOB_IN_TENANT_SQL, [jobId, tenantId])).rows;
    const job = jobs.find((row) => (
      String(row.id || '').toLowerCase() === jobId
      && String(row.tenant_id || '').toLowerCase() === String(tenantId).toLowerCase()
    ));
    if (!job) {
      return { statusCode: 403, error: 'cash_job_not_in_tenant', message: 'The cash job is not in this tenant' };
    }
    const paymentClass = blankLink(rawClass) ? 'other' : String(rawClass);
    if (!CASH_JOB_PAYMENT_CLASSES.includes(paymentClass)) {
      return { statusCode: 400, error: 'invalid_field', field: 'cash_job_payment_class' };
    }
    links.cashJobId = jobId;
    links.cashJobName = job.job_name ?? null;
    links.paymentClass = paymentClass;
  }
  return { links };
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
    const resolved = await resolveCreateLinks(client, derived.tenantId, body);
    if (resolved.error) return denied(spoof, resolved);
    const links = resolved.links;
    const checkId = isUuid(body.id) ? String(body.id) : crypto.randomUUID();
    const placeholder = `checks/${checkId}/pending_front.jpg`;
    const values = coerced.values || {};
    // The cash-job columns are named only when the check is a cash-job check,
    // so an ordinary create does not depend on them.
    const linkColumns = ['claim_id'];
    const linkValues = ['$18::uuid'];
    const linkParams = [links.claimId];
    if (links.cashJobId) {
      linkColumns.push('cash_job_id', 'check_source', 'cash_job_payment_class');
      linkValues.push('$19::uuid', "'cash_job'", '$20::text');
      linkParams.push(links.cashJobId, links.paymentClass);
    }
    const rows = (await client.query(
      `INSERT INTO public.check_intake_items (
         id, tenant_id, uploaded_by, status, check_stage, ocr_status,
         front_image_path, back_image_path, ocr_needs_verification,
         carrier_name, check_number, payee_line, property_address,
         funds_type, review_notes, payee_address, expiration_days,
         is_multi_payee, issue_date, amount, ${linkColumns.join(', ')}
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::check_stage, 'pending',
         $6::text, NULL, false,
         $7::text, $8::text, $9::text, $10::text,
         $11::text, $12::text, $13::text, $14::int,
         $15::boolean, $16::date, $17::numeric, ${linkValues.join(', ')}
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
        ...linkParams,
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
          claim_id: links.claimId,
          cash_job_id: links.cashJobId,
          check_source: links.cashJobId ? 'cash_job' : null,
          cash_job_payment_class: links.paymentClass,
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
        claimId: links.claimId,
        cashJobId: links.cashJobId,
        cashJobName: links.cashJobName,
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
    // Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
    const roleAllowed = decided.spec.requiredRole === 'tenant_member'
      && await isTenantMember(client, mapping.application_user_id, looked.check.tenant_id);
    if (!roleAllowed) {
      return denied(spoof, { error: 'insufficient_role', message: 'Transition requires a member of this check\'s company' });
    }
    const notes = asText(body.review_notes || body.p_reviewer_notes, 2000);
    if (notes.error) return denied(spoof, { statusCode: 400, ...notes });
    const homeownerUpload = HOMEOWNER_CLAIM_LINK_ACTIONS.has(action)
      ? await loadHomeownerUploadForCheck(client, looked.check)
      : null;
    if (homeownerUpload && !looked.check.claim_id) {
      return denied(spoof, {
        statusCode: 409,
        error: 'homeowner_upload_needs_claim',
        message: 'Link this check to a claim first so the homeowner can follow it.',
      });
    }
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
         AND tenant_id IS NOT DISTINCT FROM $8::uuid
         AND claim_id IS NOT DISTINCT FROM $6::uuid
         AND status IS NOT DISTINCT FROM $7::text
         AND deposited_at IS NULL
       RETURNING *`,
      [
        looked.check.id,
        decided.nextStatus,
        decided.nextStage,
        mapping.application_user_id,
        notes.value,
        looked.check.claim_id,
        looked.check.status,
        looked.check.tenant_id,
      ],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not writable or no longer matches its expected state' });
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
    if (homeownerUpload) {
      await linkHomeownerUploadToClaim(client, homeownerUpload, looked.check);
    }
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

// Owner 2026-11-16 ("Delete, keep charge (Recommended)"): a check with a ChecksOps charge can be deleted; the
// charge stays. SQL 169 made check_billing_events.check_intake_item_id ON DELETE SET NULL, so every billing row
// of a deleted check would now stay, unlinked. The rows that never blocked a delete before (and that the old
// ON DELETE CASCADE removed with the check) are still removed with it: voided rows, and the provisional
// mortgage_handling event written when a check enters Review while it is not invoiced. Every other row is a
// real charge: it is kept (unlinked by the key) and listed in the check_deletion_log snapshot.
export const CHECK_BILLING_EVENTS_FOR_DELETE_SQL = `SELECT e.id, e.event_type, e.status, e.unit_price_cents,
       to_jsonb(e)->>'invoice_id' AS invoice_id, e.billed_at
  FROM public.check_billing_events e
 WHERE e.check_intake_item_id = $1::uuid
 ORDER BY e.billed_at, e.id`;

/** The billing rows the old ON DELETE CASCADE removed with the check (they never blocked a delete). */
export const isProvisionalBillingEvent = (row) => row?.status === 'voided'
  || (row?.event_type === 'mortgage_handling' && row?.status !== 'invoiced' && row?.invoice_id == null);

/**
 * Reads the check's billing rows, removes the provisional ones under the money-write flag (SQL 136) and
 * returns the charges that stay. { error } when the rows cannot be read or the provisional ones cannot be
 * removed: the delete is then refused, so no stray provisional charge outlives its check.
 */
export async function settleBillingEventsForCheckDelete(client, checkId) {
  await client.query('SAVEPOINT delete_billing_events');
  try {
    const rows = (await client.query(CHECK_BILLING_EVENTS_FOR_DELETE_SQL, [checkId])).rows || [];
    const provisional = rows.filter(isProvisionalBillingEvent).map((row) => String(row.id));
    let removed = [];
    if (provisional.length) {
      await setMoneyWriteFlag(client);
      removed = ((await client.query(`DELETE FROM public.check_billing_events e
         WHERE e.check_intake_item_id = $1::uuid
           AND e.id = ANY($2::uuid[])
           AND (e.status = 'voided'
                OR (e.event_type = 'mortgage_handling'
                    AND e.status IS DISTINCT FROM 'invoiced'
                    AND to_jsonb(e)->>'invoice_id' IS NULL))
         RETURNING e.id`, [checkId, provisional])).rows || []).map((row) => String(row.id));
      if (removed.length !== provisional.length) {
        await client.query('ROLLBACK TO SAVEPOINT delete_billing_events');
        await client.query('RELEASE SAVEPOINT delete_billing_events');
        return { error: 'billing_cleanup_incomplete' };
      }
    }
    await client.query('RELEASE SAVEPOINT delete_billing_events');
    const gone = new Set(removed);
    const kept = rows.filter((row) => !gone.has(String(row.id))).map((row) => ({
      id: row.id,
      event_type: row.event_type ?? null,
      status: row.status ?? null,
      unit_price_cents: row.unit_price_cents ?? null,
      invoice_id: row.invoice_id ?? null,
      billed_at: row.billed_at ?? null,
    }));
    return { kept, removed };
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT delete_billing_events'); } catch { /* ignore */ }
    try { await client.query('RELEASE SAVEPOINT delete_billing_events'); } catch { /* ignore */ }
    // No billing table on this schema snapshot: nothing to keep or remove.
    if (error?.code === '42P01') return { kept: [], removed: [] };
    if (error?.code === '42501') return { error: 'billing_cleanup_denied' };
    throw error;
  }
}

// Owner 2026-11-17: a check's deposit record does not block a delete when it never left the deposit queue, that is
// status pending_assignment and no batch, provider, submission, reconciliation, clearing, exception, NSF or closeout
// data (workflow-rpc.mjs prepare_deposit writes exactly that row plus one 'prepare_deposit' deposit_audit_log row).
// Nor, since the owner's check was refused with "status provider_assigned; set: batch_id, provider" (2026-11-17), when
// it was only assigned to a provider and a batch (workflow-rpc.mjs assign_provider: those three fields plus one
// 'assign_provider' audit row) and that batch is still open with nothing submitted or cleared.
// The record and its 'prepare_deposit' / 'assign_provider' audit rows go with the check, an assigned record is taken
// out of its batch's totals, and all of it is listed in the check_deletion_log snapshot (deposit_queue_removed).
// Anything further still blocks: a deposit record that reached any other field below, a batch that is not open, or
// any related deposit record (provider attempts, exceptions, webhooks, escalations, attachments, or an audit row of
// another action).
export const DEPOSIT_ITEMS_FOR_DELETE_SQL = `SELECT to_jsonb(di) AS item
  FROM public.deposit_items di
 WHERE di.check_id = $1::uuid
 ORDER BY di.created_at, di.id`;

/** deposit_items columns that are set only once a deposit leaves the queue. */
export const DEPOSIT_QUEUE_PROGRESS_FIELDS = Object.freeze([
  'batch_id', 'provider', 'provider_reference', 'provider_payload', 'provider_response', 'provider_status_raw',
  'submitted_at', 'last_synced_at',
  'increase_account_id', 'increase_check_deposit_id', 'increase_status', 'increase_submitted_at',
  'increase_last_synced_at', 'increase_raw_response',
  'reconciled_amount', 'reconciled_at', 'reconciled_by', 'bank_reference', 'bank_confirmed_at', 'bank_confirmed_by',
  'deposit_slip_number', 'variance_reason', 'accounting_synced_at',
  'cleared_at',
  'exception_reason', 'exception_code', 'return_reason',
  'closeout_at', 'closeout_by',
]);

/** What a deposit record reached beyond the queue ([] when it never left it). An unreadable row counts as reached. */
export const depositQueueProgress = (row) => {
  if (!row || typeof row !== 'object' || !row.id) return ['unreadable'];
  const reached = [];
  if (row.status !== 'pending_assignment') reached.push(`status:${row.status ?? 'unknown'}`);
  for (const field of DEPOSIT_QUEUE_PROGRESS_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) reached.push(field);
  }
  if (row.variance_amount !== undefined && row.variance_amount !== null && Number(row.variance_amount) !== 0) reached.push('variance_amount');
  if (row.nsf_flag === true) reached.push('nsf_flag');
  if (row.closeout_complete === true) reached.push('closeout_complete');
  return reached;
};

/**
 * Assigned to a provider and a batch, with nothing after it (owner 2026-11-17): these alone do not block Delete Check.
 * The batch itself must still be open and unsubmitted (planDepositQueueForCheckDelete reads it).
 */
export const DEPOSIT_ASSIGNED_ONLY_PROGRESS = Object.freeze(['status:provider_assigned', 'batch_id', 'provider']);

/** What blocks the delete: [] for a queue record or one that was only assigned; otherwise everything it reached. */
export const depositBlockingProgress = (row) => {
  const reached = depositQueueProgress(row);
  return reached.every((entry) => DEPOSIT_ASSIGNED_ONLY_PROGRESS.includes(entry)) ? [] : reached;
};

/** Why a deposit batch blocks the delete ([] when it is open and nothing was submitted or cleared from it). */
export const depositBatchProgress = (batch) => {
  if (!batch || typeof batch !== 'object' || !batch.id) return ['unreadable'];
  const reached = [];
  if (batch.status !== 'open') reached.push(`status:${batch.status ?? 'unknown'}`);
  for (const field of ['submitted_at', 'cleared_at']) {
    if (batch[field] !== undefined && batch[field] !== null) reached.push(field);
  }
  for (const field of ['cleared_amount', 'failed_amount']) {
    if (batch[field] !== undefined && batch[field] !== null && Number(batch[field]) !== 0) reached.push(field);
  }
  return reached;
};

export const DEPOSIT_BATCHES_FOR_DELETE_SQL = `SELECT to_jsonb(b) AS batch
  FROM public.deposit_batches b
 WHERE b.id = ANY($1::uuid[])
 ORDER BY b.id`;

/**
 * What a refused deposit record reached, in words, for the refusal message (the website shows only the message):
 * "status provider_assigned; set: batch_id, provider". Field names and the status only, never a stored value.
 */
export const describeDepositQueueProgress = (reached) => {
  const list = Array.isArray(reached) ? reached.map((entry) => String(entry)) : [];
  if (!list.length) return '';
  if (list.includes('unreadable')) return 'the deposit record could not be read';
  const status = list.find((entry) => entry.startsWith('status:'));
  const fields = list.filter((entry) => !entry.startsWith('status:'));
  return [status ? `status ${status.slice('status:'.length)}` : null, fields.length ? `set: ${fields.join(', ')}` : null]
    .filter(Boolean).join('; ');
};

/** Related deposit records: any row for the check's deposit record blocks the delete. */
export const DEPOSIT_QUEUE_RELATED_BLOCKERS = Object.freeze([
  ...['deposit_provider_attempts', 'deposit_exceptions', 'deposit_webhook_events', 'deposit_escalation_events', 'deposit_attachments']
    .map((table) => ({ table, sql: `SELECT 1 FROM public.${table} WHERE deposit_item_id = ANY($1::uuid[]) LIMIT 1` })),
  { table: 'deposit_audit_log', sql: `SELECT 1 FROM public.deposit_audit_log
      WHERE deposit_item_id = ANY($1::uuid[]) AND (action IS NULL OR action NOT IN ('prepare_deposit', 'assign_provider')) LIMIT 1` },
]);

export const DEPOSIT_QUEUE_AUDIT_FOR_DELETE_SQL = `SELECT to_jsonb(a) AS entry
  FROM public.deposit_audit_log a
 WHERE a.deposit_item_id = ANY($1::uuid[]) AND a.action IN ('prepare_deposit', 'assign_provider')
 ORDER BY a.created_at, a.id`;

const inDeleteSavepoint = async (client, name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (error) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* ignore */ }
    try { await client.query(`RELEASE SAVEPOINT ${name}`); } catch { /* ignore */ }
    throw error;
  }
};

/**
 * Reads the check's deposit records (read-only). { items, audit } lists the queue-only records and their
 * 'prepare_deposit' audit rows that go with the check (both [] when the check has no deposit record).
 * { error, blocker, reached? } when a deposit record left the queue, a related deposit record exists, or the
 * records cannot be read: the delete is then refused.
 */
export async function planDepositQueueForCheckDelete(client, checkId) {
  const read = async (name, table, sql, params) => {
    try {
      return { rows: await inDeleteSavepoint(client, name, async () => (await client.query(sql, params)).rows || []) };
    } catch (error) {
      // A table absent on this schema snapshot holds nothing.
      if (error?.code === '42P01') return { rows: [] };
      if (error?.code === '42501') return { error: 'blocker_verification_denied', blocker: table };
      throw error;
    }
  };
  const found = await read('delete_deposit_queue_read', 'deposit_items', DEPOSIT_ITEMS_FOR_DELETE_SQL, [checkId]);
  if (found.error) return found;
  if (!found.rows.length) return { items: [], audit: [], batches: [] };
  const items = found.rows.map((row) => row?.item);
  for (const item of items) {
    const reached = depositBlockingProgress(item);
    if (reached.length) return { error: 'check_has_financial_activity', blocker: 'deposit_items', reached };
  }
  const ids = items.map((item) => String(item.id));
  // An assigned record sits in a batch: the batch must be readable, open, and have nothing submitted or cleared.
  const batchIds = [...new Set(items.map((item) => item.batch_id).filter(Boolean).map(String))];
  let batches = [];
  if (batchIds.length) {
    const read_ = await read('delete_deposit_queue_batches', 'deposit_batches', DEPOSIT_BATCHES_FOR_DELETE_SQL, [batchIds]);
    if (read_.error) return read_;
    batches = read_.rows.map((row) => row?.batch ?? row);
    for (const batchId of batchIds) {
      const reached = depositBatchProgress(batches.find((batch) => String(batch?.id) === batchId));
      if (reached.length) return { error: 'check_has_financial_activity', blocker: 'deposit_batches', reached };
    }
  }
  for (const [idx, related] of DEPOSIT_QUEUE_RELATED_BLOCKERS.entries()) {
    const rows = await read(`delete_deposit_queue_related_${idx}`, related.table, related.sql, [ids]);
    if (rows.error) return rows;
    if (rows.rows.length) return { error: 'check_has_financial_activity', blocker: related.table };
  }
  const audit = await read('delete_deposit_queue_audit', 'deposit_audit_log', DEPOSIT_QUEUE_AUDIT_FOR_DELETE_SQL, [ids]);
  if (audit.error) return audit;
  return { items, audit: audit.rows.map((row) => row?.entry ?? row), batches };
}

/**
 * Removes the planned queue-only deposit records and their 'prepare_deposit' audit rows. The DELETE repeats the
 * queue-only test, so a record that moved on since the plan is not removed. { error } when a row is refused or
 * left behind (the API role may not delete it, or another record still references it): the delete is then
 * refused and nothing is removed.
 */
export async function removeDepositQueueForCheckDelete(client, checkId, plan) {
  if (!plan?.items?.length) return { items: 0, audit: 0, batches: 0 };
  const ids = plan.items.map((item) => String(item.id));
  await client.query('SAVEPOINT delete_deposit_queue');
  const undo = async () => {
    try { await client.query('ROLLBACK TO SAVEPOINT delete_deposit_queue'); } catch { /* ignore */ }
    try { await client.query('RELEASE SAVEPOINT delete_deposit_queue'); } catch { /* ignore */ }
  };
  try {
    let audit = 0;
    if (plan.audit.length) {
      audit = ((await client.query(`DELETE FROM public.deposit_audit_log a
         WHERE a.deposit_item_id = ANY($1::uuid[]) AND a.action IN ('prepare_deposit', 'assign_provider')
         RETURNING a.id`, [ids])).rows || []).length;
    }
    // Take each assigned record out of its batch's totals while the record still exists (the batch is reached
    // through its records). Only an open, unsubmitted batch is changed; the batch row itself stays.
    let batches = 0;
    const batched = plan.items.filter((item) => item.batch_id);
    for (const item of batched) {
      batches += ((await client.query(`UPDATE public.deposit_batches b
          SET total_items = GREATEST(b.total_items - 1, 0),
              total_amount = GREATEST(b.total_amount - COALESCE($2::numeric, 0), 0),
              updated_at = now()
        WHERE b.id = $1::uuid AND b.status = 'open' AND b.submitted_at IS NULL AND b.cleared_at IS NULL
        RETURNING b.id`, [String(item.batch_id), item.amount ?? null])).rows || []).length;
    }
    const items = ((await client.query(`DELETE FROM public.deposit_items di
       WHERE di.id = ANY($1::uuid[])
         AND di.check_id = $2::uuid
         AND di.status IN ('pending_assignment', 'provider_assigned')
         AND di.provider_reference IS NULL
         AND di.submitted_at IS NULL
         AND di.cleared_at IS NULL
       RETURNING di.id`, [ids, checkId])).rows || []).length;
    if (audit !== plan.audit.length || items !== plan.items.length || batches !== batched.length) {
      await undo();
      return { error: 'deposit_cleanup_incomplete' };
    }
    await client.query('RELEASE SAVEPOINT delete_deposit_queue');
    return { items, audit, batches };
  } catch (error) {
    await undo();
    // 42501: the role may not delete these rows; 23503: a record this code does not know still references them.
    if (error?.code === '42501' || error?.code === '23503') return { error: 'deposit_cleanup_denied' };
    throw error;
  }
}

// Owner 2026-11-17 ("We tried to deposit but the image wasn't accepted"): a Check Alt deposit record does not block
// Delete Check when Check Alt never took the deposit, that is:
//   - queued / pending and never sent (no send attempt, no Check Alt reference, nothing submitted), or
//   - rejected (Check Alt, or an operator through Check Alt, refused it), or
//   - error with no Check Alt reference (Check Alt answered with an error and gave nothing to track),
// and in every case nothing cleared, returned or approved, and the status is not marked unresolved.
// It still blocks when Check Alt took it or may have: submitting (a send whose outcome is unknown), submitted,
// pending_approval, cleared, returned, duplicate, any other status, or a wallet funding entry made from it.
// The rows go with the check through their ON DELETE CASCADE key and are listed in the check_deletion_log snapshot
// (checkalt_deposits_removed).
export const CHECKALT_DEPOSITS_FOR_DELETE_SQL = `SELECT to_jsonb(d) AS deposit
  FROM public.checkalt_deposits d
 WHERE d.check_intake_item_id = $1::uuid
 ORDER BY d.created_at, d.id`;

export const CHECKALT_WALLET_FUNDING_FOR_DELETE_SQL = `SELECT 1 FROM public.wallet_funding_queue
 WHERE checkalt_deposit_id = ANY($1::uuid[]) LIMIT 1`;

/** Why a Check Alt deposit record blocks the delete ([] when Check Alt never took the deposit). */
export const checkAltDepositProgress = (row) => {
  if (!row || typeof row !== 'object' || !row.id) return ['unreadable'];
  const status = String(row.status ?? 'unknown');
  const has = (field) => row[field] !== undefined && row[field] !== null;
  const taken = ['cleared_at', 'returned_at', 'approved_at'].filter(has);
  if (row.status_unresolved === true) taken.push('status_unresolved');
  const neverSent = (status === 'queued' || status === 'pending')
    && !has('provider_http_attempted_at') && !has('checkalt_reference') && !has('submitted_at');
  const refused = status === 'rejected' || (status === 'error' && !has('checkalt_reference') && !has('submitted_at'));
  if ((neverSent || refused) && !taken.length) return [];
  return [`status:${status}`, ...['provider_http_attempted_at', 'checkalt_reference', 'submitted_at'].filter(has), ...taken];
};

/**
 * Reads the check's Check Alt deposit records (read-only). { deposits } lists the records Check Alt never took
 * ([] when there is none): they go with the check. { error, blocker, reached? } when Check Alt took one or may
 * have, a wallet funding entry was made from one, or the records cannot be read: the delete is then refused.
 */
export async function planCheckAltDepositsForCheckDelete(client, checkId) {
  const read = async (name, table, sql, params) => {
    try {
      return { rows: await inDeleteSavepoint(client, name, async () => (await client.query(sql, params)).rows || []) };
    } catch (error) {
      if (error?.code === '42P01') return { rows: [] };
      if (error?.code === '42501') return { error: 'blocker_verification_denied', blocker: table };
      throw error;
    }
  };
  const found = await read('delete_checkalt_read', 'checkalt_deposits', CHECKALT_DEPOSITS_FOR_DELETE_SQL, [checkId]);
  if (found.error) return found;
  if (!found.rows.length) return { deposits: [] };
  const deposits = found.rows.map((row) => row?.deposit);
  for (const deposit of deposits) {
    const reached = checkAltDepositProgress(deposit);
    if (reached.length) return { error: 'check_has_financial_activity', blocker: 'checkalt_deposits', reached };
  }
  const funding = await read('delete_checkalt_funding', 'wallet_funding_queue', CHECKALT_WALLET_FUNDING_FOR_DELETE_SQL, [deposits.map((d) => String(d.id))]);
  if (funding.error) return funding;
  if (funding.rows.length) return { error: 'check_has_financial_activity', blocker: 'wallet_funding_queue' };
  return { deposits };
}

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
    // Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
    if (!(await isTenantMember(client, mapping.application_user_id, looked.check.tenant_id))) {
      return denied(spoof, { error: 'not_authorized', message: 'Only a member of this check\'s company can delete it' });
    }
    // Owner policy: a member deletes a check with a reason, shared or not. Sharing does not block:
    // the check's shared_checks rows are removed with it (ON DELETE CASCADE), which unshares it.
    if (isTerminalFinancial(looked.check)) {
      return denied(spoof, {
        error: 'check_terminal_financial_state',
        message: 'This check cannot be deleted because it has already reached a terminal financial state (e.g. deposited or released).',
      });
    }

    // A deposit record that never left the deposit queue does not block (owner 2026-11-17): it is removed with
    // the check below. One that went further, or any related deposit record, still does.
    const depositQueue = await planDepositQueueForCheckDelete(client, looked.check.id);
    if (depositQueue.error) {
      const unverified = depositQueue.error === 'blocker_verification_denied';
      return denied(spoof, {
        error: depositQueue.error,
        message: unverified
          ? `This check cannot be deleted because the service cannot verify financial/provider blockers (${depositQueue.blocker}).`
          : `This check cannot be deleted because it has dependent financial/provider records (${depositQueue.blocker}).${
            !depositQueue.reached ? ''
              : depositQueue.blocker === 'deposit_batches'
                ? ` Its deposit batch is no longer open (${describeDepositQueueProgress(depositQueue.reached).replace('the deposit record', 'the deposit batch')}).`
                : ` Its deposit record went beyond the deposit queue (${describeDepositQueueProgress(depositQueue.reached)}).`}`,
        blocker: depositQueue.blocker,
        ...(depositQueue.reached ? { reached: depositQueue.reached } : {}),
      });
    }

    // A Check Alt deposit record that Check Alt never took (never sent, rejected, or an error with no reference)
    // goes with the check; one it took, or may have, still blocks.
    const checkAlt = await planCheckAltDepositsForCheckDelete(client, looked.check.id);
    if (checkAlt.error) {
      return denied(spoof, {
        error: checkAlt.error,
        message: checkAlt.error === 'blocker_verification_denied'
          ? `This check cannot be deleted because the service cannot verify financial/provider blockers (${checkAlt.blocker}).`
          : `This check cannot be deleted because it has dependent financial/provider records (${checkAlt.blocker}).${
            !checkAlt.reached ? ''
              : ` Check Alt took this deposit or may have (${describeDepositQueueProgress(checkAlt.reached).replace('the deposit record', 'the Check Alt deposit record')}).`}`,
        blocker: checkAlt.blocker,
        ...(checkAlt.reached ? { reached: checkAlt.reached } : {}),
      });
    }

    // Refuse delete once a check has entered any financial/provider pipeline tables.
    // Deleting those records is intentionally out of scope for the AWS workflow write tranche.
    const blockers = [
      { table: 'disbursement_batches', sql: 'SELECT 1 FROM public.disbursement_batches WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      { table: 'claim_check_payments', sql: 'SELECT 1 FROM public.claim_check_payments WHERE check_intake_item_id = $1::uuid LIMIT 1' },
      // claim_payments is not a blocker: its check link is ON DELETE SET NULL, so the claim keeps the
      // payment and only loses the link (claim linkage is not a blocker).
      // Billing events do not block (owner 2026-11-16, "Delete, keep charge"): SQL 169 made their check
      // link ON DELETE SET NULL, so a charge stays in billing history, unlinked; see
      // settleBillingEventsForCheckDelete below.
      // Financial tables keyed by claim_checks.id. Join via claim_checks.check_intake_item_id.
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
      // Defensive: if accounting deposit_status says deposited/cleared/settled, refuse deletion even if
      // check_intake_items hasn't reflected a terminal stage yet.
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
        // Always roll back to a savepoint on error; otherwise the outer transaction is aborted.
        try { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* ignore */ }
        try { await client.query(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* ignore */ }
        // If a table is absent on this schema snapshot, do not treat it as a blocker.
        if (error?.code === '42P01') continue;
        // If we cannot even read blockers, refuse deletion rather than returning a 503.
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

    // S3 cleanup: gather only object keys conclusively owned by this check.
    // Must plan before DB cascades remove check_files and related metadata.
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

      // Claim-files check-scoped prefixes cover originals, crops, composites, and other generated artifacts.
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

      // Endorsement packets are stored under an endorsement-packets prefix; delete only for this tenant+check.
      if (collected.tenantId) {
        const tenantId = String(collected.tenantId);
        for (const prefixKey of [
          `files/claim-files/endorsement-packets/${tenantId}/${checkIdText}`,
          `files/endorsement-packets/${tenantId}/${checkIdText}`,
        ]) {
          const found = await listKeysByPrefix(deps, prefixKey);
          for (const k of found) {
            if (prefixKey.startsWith('files/claim-files/')) {
              const rel = String(k).replace(/^files\/claim-files\//, '');
              if (!String(rel).toLowerCase().startsWith(`endorsement-packets/${tenantId.toLowerCase()}/${checkIdText.toLowerCase()}`)) continue;
            } else if (prefixKey.startsWith('files/endorsement-packets/')) {
              const rel = String(k).replace(/^files\/endorsement-packets\//, '');
              if (!String(rel).toLowerCase().startsWith(`${tenantId.toLowerCase()}/${checkIdText.toLowerCase()}`)) continue;
            }
            keySet.add(k);
          }
        }
      }

      plannedStorageKeys = [...keySet];
      plannedStorageKeyCount = plannedStorageKeys.length;
      plannedStorageKeySample = plannedStorageKeys.slice(0, 50);
    }

    // Charges stay (unlinked by SQL 169's key); provisional billing rows go, as the old cascade did.
    const billing = await settleBillingEventsForCheckDelete(client, looked.check.id);
    if (billing.error) {
      return denied(spoof, {
        error: billing.error,
        message: 'This check cannot be deleted because its billing records could not be settled. Nothing was deleted.',
      });
    }

    // The queue-only deposit record and its 'prepare_deposit' audit rows go with the check.
    const depositRemoved = await removeDepositQueueForCheckDelete(client, looked.check.id, depositQueue);
    if (depositRemoved.error) {
      return denied(spoof, {
        error: depositRemoved.error,
        message: 'This check cannot be deleted because its deposit queue record could not be removed. Nothing was deleted.',
        blocker: 'deposit_items',
      });
    }
    const depositQueueRemoved = { deposit_items: depositQueue.items, deposit_audit_log: depositQueue.audit, deposit_batches_adjusted: depositQueue.batches };

    // Preserve an audit snapshot before deleting the check + check_audit_log rows.
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
              JSON.stringify({ ...row, billing_events_kept: billing.kept, deposit_queue_removed: depositQueueRemoved, checkalt_deposits_removed: checkAlt.deposits }),
            ],
          );
        }
      }
    } catch {
      // Best-effort audit snapshot; deletion must still proceed.
      try { await client.query('ROLLBACK TO SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      auditSavepointHeld = false;
    }

    // Rely on FK ON DELETE CASCADE for dependent records (payees/files/messages/etc).
    // We explicitly block financial/provider tables above; those are the non-cascading integrity holders.
    //
    // Some legacy schemas may still hold non-financial FK references (ex: claim_checks, loss_draft_tracking)
    // that are not cascading. Only attempt to clean those up if the delete actually fails with an FK error.
    let rows = [];
    // IMPORTANT: any failed statement aborts the entire transaction until a rollback.
    // Use a savepoint so we can safely recover from FK violations and retry after
    // best-effort cleanup of non-financial links.
    await client.query('SAVEPOINT delete_check_attempt');
    try {
      rows = (await client.query(
        'DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id',
        [looked.check.id],
      )).rows;
      await client.query('RELEASE SAVEPOINT delete_check_attempt');
    } catch (error) {
      // Recover transaction state before any further queries.
      try { await client.query('ROLLBACK TO SAVEPOINT delete_check_attempt'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_check_attempt'); } catch { /* ignore */ }
      if (error?.code !== '23503') throw error; // not a foreign key violation

      // Retry path: attempt best-effort cleanup of non-financial claim/escrow links, then retry delete.
      await client.query('SAVEPOINT delete_claim_links');
      try {
        await client.query('DELETE FROM public.claim_checks WHERE check_intake_item_id = $1::uuid', [looked.check.id]);
        await client.query('UPDATE public.loss_draft_tracking SET check_intake_item_id = NULL WHERE check_intake_item_id = $1::uuid', [looked.check.id]);
        await client.query('RELEASE SAVEPOINT delete_claim_links');
      } catch (cleanupError) {
        try { await client.query('ROLLBACK TO SAVEPOINT delete_claim_links'); } catch { /* ignore */ }
        try { await client.query('RELEASE SAVEPOINT delete_claim_links'); } catch { /* ignore */ }
        if (cleanupError?.code === '42P01' || cleanupError?.code === '42703') {
          // schema mismatch (table/column absent): ignore and proceed to retry delete anyway
        } else if (cleanupError?.code === '42501') {
          // The AWS application role cannot always delete claim_checks / loss_draft_tracking directly
          // (RLS policies are scoped to the authenticated role). Fall back to the SECURITY DEFINER
          // function that performs the same non-financial cleanup, after our explicit blockers ran.
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

      // If the cleanup ran (or was ignored), retry delete.
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
    if (!(await isTenantMember(client, mapping.application_user_id, before.tenant_id))) {
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
