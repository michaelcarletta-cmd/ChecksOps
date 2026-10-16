/**
 * E-sign source "From Document Library" (signature-library-document-copy).
 *
 * A member of the document's tenant copies one non-mortgage library document
 * (template, catalog, shingle, siding, letterhead) into the signature folder of
 * a claim or check of that same tenant:
 *   claim-files/signatures/{claimId}/library-{ts}-{uuid}.{pdf|docx}
 *   claim-files/check-intake/{checkId}/files/library-{ts}-{uuid}.{pdf|docx}
 * and gets that path back (plus a 5 minute GET URL of the copy, to place the
 * signature fields). authorizeSignatureDocumentPath (write-signature.mjs) stays
 * as strict as it is: a tenant-documents path is never a signature document;
 * only the copy, which is check- or claim-scoped, is.
 */
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { ignoredSpoof, parseBody, withIdentityWrite } from './data.mjs';
import { s3KeyFor } from './storage-paths.mjs';
import { authorizeSignatureDocumentPath } from './write-signature.mjs';
import { LIBRARY_BUCKET, LIBRARY_MAX_BYTES, normalizeContentType } from './tenant-library-rules.mjs';
import { claimBelongsToTenant, isTenantMember, shareableLibraryDocument } from './tenant-library.mjs';
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
  if (!shareableLibraryDocument(doc, tenantId)) return refuse(403, 'document_not_signable', spoof);

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
  if (deps.forceWrites !== true && !(writesEnabled() && storageWritesEnabled())) {
    return refuse(403, 'writes_disabled', spoof);
  }
  return withIdentityWrite(event, (ctx) => runSignatureLibraryDocumentCopy({ ...ctx, deps }), deps);
};
