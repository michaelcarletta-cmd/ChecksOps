/**
 * Narrow AWS write path for the existing first-party signature engine.
 * Inserts signature_requests / signature_signers only. Does not mint tokens,
 * send email, flatten PDFs, move check/claim stages, or call billing/deposit.
 */
import { normalizePath } from './storage-paths.mjs';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOC_TYPES = new Set([
  'authorization',
  'release',
  'affidavit',
  'direction_to_pay',
  'other',
  'custom',
]);
const SIGNER_TYPES = new Set(['policyholder', 'homeowner', 'mortgagee', 'contractor', 'other']);

const isUuid = (value) => UUID_RE.test(String(value || ''));
const eqFilter = (filters, column) => {
  const match = (filters || []).find((filter) => filter?.column === column && (filter.op || 'eq') === 'eq');
  return match?.value ?? null;
};

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  return text.length ? text : null;
};

const asDocumentPath = (value) => {
  const rel = normalizePath(value, 'claim-files');
  if (!rel || rel.length > 512) return { error: 'invalid_field', field: 'document_path' };
  return { value: rel };
};

const lowerId = (value) => String(value).toLowerCase();

/** Paths the app writes for one check (generated PDFs, check files, images). */
const checkScopedPrefixes = (checkId) => [
  `check-intake/${lowerId(checkId)}/`,
  `checks/${lowerId(checkId)}/`,
  `checks/reupload/${lowerId(checkId)}/`,
];

/**
 * A signature document must belong to the request's own check or claim.
 * loss_draft_documents.file_path is not trusted here: members can set it to
 * any string, so loss-draft documents must sit in the check or claim folders.
 * Storage read access is granted to any signature_requests.document_path the
 * caller can see, so an unscoped path would let one tenant read (and send to
 * an outside signer) another tenant's file.
 */
export const authorizeSignatureDocumentPath = async (client, { path, claimId, checkId }) => {
  const rel = String(path || '');
  const lower = rel.toLowerCase();
  if (!rel || rel.includes('..')) return false;
  if (checkId && checkScopedPrefixes(checkId).some((prefix) => lower.startsWith(prefix))) return true;
  if (claimId && lower.startsWith(`signatures/${lowerId(claimId)}/`)) return true;
  if (!new RegExp(`^${UUID_PATTERN}$`, 'i').test(String(checkId || claimId || ''))) return false;
  const rows = (await client.query(
    `SELECT 1 FROM public.check_files
      WHERE $2::uuid IS NOT NULL AND check_intake_item_id = $2::uuid
        AND split_part(file_path, '?', 1) = $1::text
     UNION ALL
     SELECT 1 FROM public.claim_files
      WHERE $3::uuid IS NOT NULL AND claim_id = $3::uuid
        AND split_part(file_path, '?', 1) = $1::text
     LIMIT 1`,
    [rel, checkId || null, claimId || null],
  )).rows;
  return rows.length > 0;
};

const WRITER_ROLE_SQL = `SELECT 1 FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid
       AND lower(role::text) IN ('owner', 'admin', 'manager', 'operator')
     LIMIT 1`;

/** Tenants that own a request: the claim's org, else the check's tenant, else checks on an org-less claim. */
const owningTenantIds = async (client, { claimId, checkId }) => {
  if (claimId) {
    const org = (await client.query(
      'SELECT org_id FROM public.claims WHERE id = $1::uuid LIMIT 1',
      [claimId],
    )).rows[0]?.org_id;
    if (org) return [org];
  }
  if (checkId) {
    const tenant = (await client.query(
      'SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1',
      [checkId],
    )).rows[0]?.tenant_id;
    return tenant ? [tenant] : [];
  }
  if (!claimId) return [];
  return (await client.query(
    `SELECT DISTINCT tenant_id FROM public.check_intake_items
      WHERE claim_id = $1::uuid AND tenant_id IS NOT NULL`,
    [claimId],
  )).rows.map((row) => row.tenant_id);
};

/**
 * RLS lets any member who can see a check or claim insert here, including
 * viewers and partner tenants. Only owner, admin, manager or operator members
 * of the owning tenant, or the platform owner, may add requests or signers.
 * Fails closed when no owning tenant resolves.
 */
export const authorizeSignatureWriter = async (client, { mapping, claimId, checkId }) => {
  const userId = isUuid(mapping?.application_user_id) ? mapping.application_user_id : null;
  let platformOwner;
  for (const tenantId of await owningTenantIds(client, { claimId, checkId })) {
    const canWrite = (await client.query(
      'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
      [tenantId],
    )).rows[0]?.ok;
    if (!canWrite) continue;
    if (userId && (await client.query(WRITER_ROLE_SQL, [userId, tenantId])).rows.length) return true;
    if (platformOwner === undefined) {
      platformOwner = (await client.query('SELECT public.is_platform_owner() AS is_owner')).rows[0]?.is_owner === true;
    }
    if (platformOwner) return true;
  }
  return false;
};

const writerDenied = { error: 'not_authorized', message: 'only owner, admin, manager or operator members may prepare signature requests' };

const lookupClaim = async (client, claimId) => {
  if (!isUuid(claimId)) return { error: 'invalid_uuid', field: 'claim_id' };
  const rows = (await client.query(
    'SELECT id FROM public.claims WHERE id = $1::uuid LIMIT 1',
    [claimId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'claim not found or not writable' };
  return { claim: rows[0] };
};

const lookupCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_intake_item_id' };
  const rows = (await client.query(
    'SELECT id, claim_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1',
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

const sameUuid = (left, right) => String(left || '').toLowerCase() === String(right || '').toLowerCase();

export const resolveSignatureRequestIds = async ({ client, values }) => {
  const callerClaimId = values.claim_id || null;
  const checkId = values.check_intake_item_id || null;
  if (!callerClaimId && !checkId) {
    return { error: 'missing_required_field', field: 'claim_id' };
  }
  if (callerClaimId && !isUuid(callerClaimId)) return { error: 'invalid_uuid', field: 'claim_id' };
  if (checkId && !isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_intake_item_id' };

  if (checkId) {
    const check = await lookupCheck(client, checkId);
    if (check.error) return check;
    const linkedClaimId = check.check.claim_id || null;
    if (callerClaimId && linkedClaimId && !sameUuid(callerClaimId, linkedClaimId)) {
      return { error: 'claim_mismatch', message: 'claim_id does not match the authorized check' };
    }
    if (callerClaimId && !linkedClaimId) {
      return { error: 'claim_mismatch', message: 'claim_id does not match the authorized check' };
    }
    return {
      claimId: linkedClaimId,
      checkId: check.check.id,
    };
  }

  const claim = await lookupClaim(client, callerClaimId);
  if (claim.error) return claim;
  return { claimId: claim.claim.id, checkId: null };
};

export const executeSignatureRequests = async ({ client, mapping, op, values }) => {
  if (op !== 'insert') return { error: 'operation_not_allowlisted', op, table: 'signature_requests' };
  const resolved = await resolveSignatureRequestIds({ client, values });
  if (resolved.error) return resolved;
  const claimId = resolved.claimId;
  const checkId = resolved.checkId;
  if (!(await authorizeSignatureWriter(client, { mapping, claimId, checkId }))) return writerDenied;
  const name = clip(values.document_name, 240);
  if (name?.error) return name;
  if (!name) return { error: 'missing_required_field', field: 'document_name' };
  const path = asDocumentPath(values.document_path);
  if (path.error) return path;
  if (!(await authorizeSignatureDocumentPath(client, { path: path.value, claimId, checkId }))) {
    return {
      error: 'not_authorized',
      field: 'document_path',
      message: "document_path must be a file of this request's own check or claim",
    };
  }
  const docType = clip(values.document_type, 64) || 'other';
  if (!DOC_TYPES.has(docType)) return { error: 'column_not_allowlisted', columns: ['document_type'] };
  const status = clip(values.status, 32) || 'draft';
  if (status !== 'draft') return { error: 'column_not_allowlisted', columns: ['status'] };
  let fieldData = values.field_data;
  if (fieldData == null) fieldData = [];
  if (typeof fieldData === 'string') {
    try { fieldData = JSON.parse(fieldData); } catch { return { error: 'invalid_field', field: 'field_data' }; }
  }
  if (!Array.isArray(fieldData)) return { error: 'invalid_field', field: 'field_data' };
  const rows = (await client.query(
    `INSERT INTO public.signature_requests (
       claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb, $7::text
     ) RETURNING *`,
    [claimId, checkId, name, path.value, docType, JSON.stringify(fieldData), status],
  )).rows;
  return { rows };
};

export const executeSignatureSigners = async ({ client, mapping, op, values }) => {
  if (op !== 'insert') return { error: 'operation_not_allowlisted', op, table: 'signature_signers' };
  const requestId = values.signature_request_id;
  if (!isUuid(requestId)) return { error: 'invalid_uuid', field: 'signature_request_id' };
  const request = (await client.query(
    `SELECT id, claim_id, check_intake_item_id, status
       FROM public.signature_requests WHERE id = $1::uuid LIMIT 1`,
    [requestId],
  )).rows[0];
  if (!request) return { error: 'rls_denied', message: 'signature request not found or not writable' };
  // Signers join a request only while it is a draft; a later send would mint
  // a token for them and email the document.
  if (String(request.status || '').toLowerCase() !== 'draft') {
    return { error: 'not_authorized', message: 'signers can be added only to a draft signature request' };
  }
  if (!(await authorizeSignatureWriter(client, {
    mapping,
    claimId: request.claim_id || null,
    checkId: request.check_intake_item_id || null,
  }))) return writerDenied;
  const signerName = clip(values.signer_name, 200);
  if (signerName?.error) return signerName;
  if (!signerName) return { error: 'missing_required_field', field: 'signer_name' };
  const signerEmail = clip(values.signer_email, 240);
  if (signerEmail?.error) return signerEmail;
  if (!signerEmail || !signerEmail.includes('@')) return { error: 'invalid_field', field: 'signer_email' };
  const signerType = (clip(values.signer_type, 40) || 'policyholder').toLowerCase();
  if (!SIGNER_TYPES.has(signerType)) return { error: 'column_not_allowlisted', columns: ['signer_type'] };
  const orderRaw = values.signing_order == null ? 1 : Number(values.signing_order);
  if (!Number.isFinite(orderRaw) || orderRaw < 1 || orderRaw > 20) {
    return { error: 'invalid_field', field: 'signing_order' };
  }
  const rows = (await client.query(
    `INSERT INTO public.signature_signers (
       signature_request_id, signer_name, signer_email, signer_type, signing_order
     ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::int)
     RETURNING *`,
    [requestId, signerName, signerEmail.toLowerCase(), signerType, Math.floor(orderRaw)],
  )).rows;
  return { rows };
};

export const executeSignatureWrite = async ({ client, mapping, table, op, values }) => {
  if (table === 'signature_requests') return executeSignatureRequests({ client, mapping, op, values });
  if (table === 'signature_signers') return executeSignatureSigners({ client, mapping, op, values });
  return { error: 'table_not_allowlisted', table };
};
