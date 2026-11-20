/**
 * E-sign source "From Document Library" (signature-library-document-copy).
 *
 * A member of the document's tenant copies one library document (template,
 * catalog, shingle, siding, letterhead, or a Mortgage packet document such as the
 * W-9) into the signature folder of a claim or check of that same tenant:
 *   claim-files/signatures/{claimId}/library-{ts}-{uuid}.{pdf|docx}
 *   claim-files/check-intake/{checkId}/files/library-{ts}-{uuid}.{pdf|docx}
 * and gets that path back (plus a 5 minute GET URL of the copy, to place the
 * signature fields). authorizeSignatureDocumentPath (write-signature.mjs) stays
 * as strict as it is: a tenant-documents path is never a signature document;
 * only the copy, which is check- or claim-scoped, is.
 *
 * action "list" (owner 2026-11-20: "It should show all files in document library
 * to add. In freedom adjustment only have w9 but it's not showing up") lists the
 * claim tenant's signable library documents, every category including Mortgage
 * packet, PDF or DOCX only. Mortgage packet documents are offered here because the
 * member chooses to send one for signature; homeowner sharing (tenant-library.mjs
 * shareableLibraryDocument, claim-library-documents) still never offers them.
 */
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { s3KeyFor } from './storage-paths.mjs';
import { authorizeSignatureDocumentPath } from './write-signature.mjs';
import { LIBRARY_BUCKET, LIBRARY_MAX_BYTES, libraryObjectPath, normalizeContentType } from './tenant-library-rules.mjs';
import { claimBelongsToTenant, isTenantMember, resolveClaimTenantForMember } from './tenant-library.mjs';
import { libraryCategoryOf } from './mortgage-library-doc-types.mjs';
import { storageWritesEnabled, writesEnabled } from './write-allowlist.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const filesBucket = () => process.env.FILES_BUCKET || '';
const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });
const SIGNATURE_BUCKET = 'claim-files';

/** Signature Requests place fields on PDF or DOCX only. */
export const SIGNABLE_TYPES = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
});

const refuse = (statusCode, error, spoof, extra = {}) => ({ ok: false, statusCode, error, spoofFieldsIgnored: spoof, ...extra });

/** A library document a member may send for signature: own tenant, any library category (Mortgage packet included), own library folder. */
export const signableLibraryDocument = (doc, tenantId) => {
  if (!doc || String(doc.tenant_id).toLowerCase() !== String(tenantId).toLowerCase()) return false;
  const category = libraryCategoryOf(doc.doc_type);
  if (!category) return false;
  return Boolean(libraryObjectPath(doc.file_path, { tenantId, category }));
};

const isSignableType = (mimeType) => Boolean(SIGNABLE_TYPES[normalizeContentType(mimeType)]);

/** The claim tenant's library documents that can be sent for signature (every category; PDF or DOCX). */
export const runSignatureLibraryDocumentList = async ({ client, mapping, body, spoof }) => {
  const resolved = await resolveClaimTenantForMember(client, mapping.application_user_id, body.claim_id, body.tenant_id || null);
  if (resolved.error) return refuse(resolved.error === 'invalid_uuid' ? 400 : 403, resolved.error, spoof, resolved.field ? { field: resolved.field } : {});
  const rows = (await client.query(
    `SELECT id, tenant_id, doc_type, file_name, file_path, mime_type, file_size, created_at
       FROM public.tenant_documents
      WHERE tenant_id = $1::uuid AND doc_type LIKE 'library:%'
      ORDER BY created_at DESC
      LIMIT 500`,
    [resolved.tenantId],
  )).rows;
  const documents = rows
    .filter((row) => signableLibraryDocument(row, resolved.tenantId) && isSignableType(row.mime_type))
    .map((row) => ({
      id: row.id,
      doc_type: row.doc_type,
      category: libraryCategoryOf(row.doc_type),
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: row.file_size,
      created_at: row.created_at,
    }));
  return { ok: true, statusCode: 200, tenant_id: resolved.tenantId, documents, spoofFieldsIgnored: spoof };
};

export const runSignatureLibraryDocumentCopy = async ({ client, mapping, body, spoof, deps = {} }) => {
  const documentId = body.tenant_document_id;
  const claimId = body.claim_id || null;
  const checkId = body.check_intake_item_id || null;
  if (!isUuid(documentId)) return refuse(400, 'invalid_uuid', spoof, { field: 'tenant_document_id' });
  if (claimId && !isUuid(claimId)) return refuse(400, 'invalid_uuid', spoof, { field: 'claim_id' });
  if (checkId && !isUuid(checkId)) return refuse(400, 'invalid_uuid', spoof, { field: 'check_intake_item_id' });
  if (!claimId && !checkId) return refuse(400, 'missing_required_field', spoof, { field: 'claim_id' });

  const doc = (await client.query(
    `SELECT id, tenant_id, doc_type, file_name, file_path, mime_type, file_size
       FROM public.tenant_documents WHERE id = $1::uuid LIMIT 1`,
    [documentId],
  )).rows[0];
  if (!doc) return refuse(404, 'document_not_found', spoof);
  const tenantId = String(doc.tenant_id);
  if (!(await isTenantMember(client, mapping.application_user_id, tenantId))) {
    return refuse(403, 'not_authorized', spoof, { message: 'Membership of the document\'s company is required' });
  }
  if (!signableLibraryDocument(doc, tenantId)) return refuse(403, 'document_not_signable', spoof);

  // The request's claim and check must be the document tenant's own.
  if (claimId && !(await claimBelongsToTenant(client, claimId, tenantId))) {
    return refuse(403, 'claim_not_in_tenant', spoof);
  }
  if (checkId) {
    const check = (await client.query(
      'SELECT id, tenant_id, claim_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1',
      [checkId],
    )).rows[0];
    if (!check || String(check.tenant_id).toLowerCase() !== tenantId.toLowerCase()) {
      return refuse(403, 'check_not_in_tenant', spoof);
    }
    if (claimId && check.claim_id && String(check.claim_id).toLowerCase() !== String(claimId).toLowerCase()) {
      return refuse(403, 'check_not_on_claim', spoof);
    }
  }

  const fromKey = s3KeyFor(LIBRARY_BUCKET, doc.file_path);
  let head;
  try {
    head = await defaultS3(deps).send(new HeadObjectCommand({ Bucket: filesBucket(), Key: fromKey }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode || error?.statusCode;
    if (status === 404 || error?.name === 'NotFound') return refuse(404, 'object_not_in_s3', spoof);
    return refuse(503, 'storage_unavailable', spoof);
  }
  const contentType = normalizeContentType(head?.ContentType || doc.mime_type);
  const ext = SIGNABLE_TYPES[contentType];
  if (!ext) return refuse(400, 'document_not_signable', spoof, { message: 'Only PDF or DOCX library documents can be sent for signature' });
  if (!(Number(head?.ContentLength) > 0 && Number(head.ContentLength) <= LIBRARY_MAX_BYTES)) {
    return refuse(400, 'document_not_signable', spoof, { message: 'Library file size is out of range' });
  }

  const file = `library-${Date.now()}-${randomUUID()}.${ext}`;
  const rel = claimId ? `signatures/${String(claimId).toLowerCase()}/${file}` : `check-intake/${String(checkId).toLowerCase()}/files/${file}`;
  // Same rule send-signature-request applies; never widened for tenant-documents.
  if (!(await authorizeSignatureDocumentPath(client, { path: rel, claimId, checkId }))) {
    return refuse(403, 'path_not_allowlisted', spoof);
  }
  const toKey = s3KeyFor(SIGNATURE_BUCKET, rel);
  try {
    await defaultS3(deps).send(new CopyObjectCommand({
      Bucket: filesBucket(),
      CopySource: encodeURI(`${filesBucket()}/${fromKey}`),
      Key: toKey,
      ContentType: contentType,
      MetadataDirective: 'REPLACE',
    }));
  } catch {
    return refuse(503, 'storage_copy_failed', spoof);
  }
  const sign = deps.getSignedUrl || getSignedUrl;
  const signedUrl = await sign(defaultS3(deps), new GetObjectCommand({ Bucket: filesBucket(), Key: toKey }), { expiresIn: 300 });
  return {
    ok: true,
    statusCode: 200,
    bucket: SIGNATURE_BUCKET,
    path: rel,
    file_name: doc.file_name || file,
    mime_type: contentType,
    is_pdf: ext === 'pdf',
    signedUrl,
    expiresIn: 300,
    tenant_id: tenantId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSignatureLibraryDocumentCopy = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  // Listing reads only: no write transaction, no writes gate.
  if (String(body.action || '').toLowerCase() === 'list') {
    return withIdentity(event, (ctx) => runSignatureLibraryDocumentList(ctx), deps);
  }
  if (deps.forceWrites !== true && !(writesEnabled() && storageWritesEnabled())) {
    return refuse(403, 'writes_disabled', spoof);
  }
  return withIdentityWrite(event, (ctx) => runSignatureLibraryDocumentCopy({ ...ctx, deps }), deps);
};
