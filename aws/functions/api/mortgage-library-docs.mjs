/**
 * Mortgage Ops document-library parity helpers.
 *
 * Application / CHECK constraint allowlist is the exact canonical set in
 * mortgage-library-doc-types.mjs. SQL 29 keeps a broader
 * `doc_type LIKE 'library:mortgage:%'` prefix check as defense in depth.
 *
 * Other library categories stay tenant-internal:
 *   library:template:%  library:shingle:%  library:siding:%
 *   library:catalog:%   library:letterhead:%
 *
 * Does not touch KYC/Moov verification paths, check images, or claim files.
 */
import {
  MORTGAGE_LIBRARY_DOC_PREFIX,
  MORTGAGE_LIBRARY_DOC_TYPES,
  isApprovedMortgageLibraryDocType,
} from './mortgage-library-doc-types.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export { MORTGAGE_LIBRARY_DOC_PREFIX, MORTGAGE_LIBRARY_DOC_TYPES, isApprovedMortgageLibraryDocType };
export const MORTGAGE_OPS_OPEN_STATUSES = Object.freeze(['requested', 'in_progress']);
export const MORTGAGE_LIBRARY_MANAGE_ROLES = Object.freeze(['admin', 'owner']);

export const isUuid = (value) => UUID_RE.test(String(value || ''));

export const isOpenMortgageRequestStatus = (status) =>
  MORTGAGE_OPS_OPEN_STATUSES.includes(String(status || '').toLowerCase());

/** Mirror of share_library_docs_to_mortgage_request() row filter. */
export const qualifyingMortgageLibraryDocsForTenant = (docs, tenantId) =>
  (docs || []).filter((doc) => (
    String(doc?.tenant_id) === String(tenantId)
    && doc?.auto_share_mortgage_ops === true
    && isApprovedMortgageLibraryDocType(doc?.doc_type)
  ));

export const mortgageAgentCanReadAttachedRequest = (request, userId) => {
  if (!request) return false;
  if (isOpenMortgageRequestStatus(request.status)) return true;
  return String(request.assigned_employee_id || '') === String(userId || '');
};

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  return text.length ? text : null;
};

const loadTenantMembership = async (client, userId, tenantId) => {
  const row = (await client.query(
    `SELECT role::text AS role FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [userId, tenantId],
  )).rows[0];
  return row || null;
};

/**
 * Tenant document library writes are tenant owner/admin only.
 * `user_roles.admin` / `staff` / `mortgage_agent` are not tenant library managers:
 * a platform or Desk role plus ordinary membership must not mutate another
 * tenant's packet. Platform owner oversight is not a library-write grant.
 */
export const canManageTenantDocumentLibrary = async (client, userId, tenantId) => {
  if (!isUuid(userId) || !isUuid(tenantId)) return false;
  const membership = await loadTenantMembership(client, userId, tenantId);
  if (!membership) return false;
  const tenantRole = String(membership.role || '').toLowerCase();
  return MORTGAGE_LIBRARY_MANAGE_ROLES.includes(tenantRole);
};

/**
 * Storage sign for Mortgage Ops. Calls a SECURITY DEFINER helper so the
 * attachment + request join is not blocked by tenant-only RLS on
 * mortgage_handling_requests. Exact path equality only; joins tenant_documents
 * to require library:mortgage:%.
 */
export const MORTGAGE_LIBRARY_STORAGE_AUTH_SQL = `
SELECT 1
WHERE public.aws_mortgage_agent_can_read_library_path($1::text[], $2::text, $3::uuid)
LIMIT 1`;

/**
 * TenantDocumentLibrary backfill: attach one already-uploaded mortgage library
 * document to one open Mortgage Desk request. Source of truth is the database
 * document + request rows, never client tenant_id / file_path / doc_type.
 */
export const executeMortgageRequestLibraryDocuments = async ({
  client, mapping, op, values,
}) => {
  if (op !== 'insert' && op !== 'upsert') {
    return { error: 'operation_not_allowlisted', op };
  }
  const requestId = values.request_id;
  const documentId = values.tenant_document_id;
  if (!isUuid(requestId)) return { error: 'invalid_uuid', field: 'request_id' };
  if (!isUuid(documentId)) return { error: 'invalid_uuid', field: 'tenant_document_id' };

  const document = (await client.query(
    `SELECT id, tenant_id, doc_type, file_name, file_path, mime_type, file_size, auto_share_mortgage_ops
     FROM public.tenant_documents
     WHERE id = $1::uuid`,
    [documentId],
  )).rows[0];
  if (!document) {
    return { error: 'rls_denied', message: 'document not found' };
  }

  if (!(await canManageTenantDocumentLibrary(client, mapping.application_user_id, document.tenant_id))) {
    return { error: 'not_authorized', message: 'Tenant owner or admin required to backfill Mortgage Ops documents' };
  }

  if (!isApprovedMortgageLibraryDocType(document.doc_type)) {
    return {
      error: 'category_not_allowlisted',
      field: 'doc_type',
      allowed_prefix: MORTGAGE_LIBRARY_DOC_PREFIX,
      allowed: MORTGAGE_LIBRARY_DOC_TYPES,
    };
  }
  if (document.auto_share_mortgage_ops !== true) {
    return { error: 'auto_share_required', message: 'auto_share_mortgage_ops must be enabled' };
  }

  const request = (await client.query(
    `SELECT id, tenant_id, status FROM public.mortgage_handling_requests WHERE id = $1::uuid`,
    [requestId],
  )).rows[0];
  if (!request) {
    return { error: 'rls_denied', message: 'mortgage request not found' };
  }
  if (String(request.tenant_id) !== String(document.tenant_id)) {
    return { error: 'tenant_mismatch', message: 'Request and document must belong to the same tenant' };
  }
  if (!isOpenMortgageRequestStatus(request.status)) {
    return { error: 'request_not_open', message: 'Closed requests do not receive new library attachments' };
  }

  const fileName = clip(document.file_name, 255);
  if (fileName?.error || !fileName) {
    return fileName?.error || { error: 'missing_required_field', field: 'file_name' };
  }
  const filePath = clip(document.file_path, 512);
  if (filePath?.error || !filePath) {
    return filePath?.error || { error: 'missing_required_field', field: 'file_path' };
  }
  const mime = clip(document.mime_type, 120);
  if (mime?.error) return mime;

  const inserted = (await client.query(
    `INSERT INTO public.mortgage_request_library_documents
       (request_id, tenant_id, tenant_document_id, doc_type, file_name, file_path, mime_type, file_size)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text, $8::bigint)
     ON CONFLICT (request_id, file_path) DO NOTHING
     RETURNING *`,
    [
      request.id,
      document.tenant_id,
      document.id,
      document.doc_type,
      fileName,
      filePath,
      mime,
      document.file_size == null ? null : Number(document.file_size),
    ],
  )).rows;
  if (inserted.length) return { rows: inserted };

  const existing = (await client.query(
    `SELECT * FROM public.mortgage_request_library_documents
     WHERE request_id = $1::uuid AND file_path = $2::text`,
    [request.id, filePath],
  )).rows;
  return { rows: existing, duplicate: true };
};
