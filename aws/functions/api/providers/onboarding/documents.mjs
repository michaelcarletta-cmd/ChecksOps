/**
 * Compliance documents: the browser uploads straight to S3 with a short-lived
 * presigned PUT (SSE-KMS with the dedicated documents key, exact content type
 * and length signed), so the 6 MB Lambda payload limit does not apply. The
 * server then verifies the stored object (HEAD + bytes + magic-byte sniff) and
 * forwards it to Moov's files API as multipart/form-data.
 *
 * S3 keys (versioned bucket):
 *   upload: files/verification-docs/uploads/{tenantId}/{documentId}  (the only presigned PUT target)
 *   final:  files/verification-docs/final/{tenantId}/{documentId}    (server copy, pinned version)
 * Finalize verifies the upload version, copies it to the final key and
 * deletes the verified upload version. No presigned URL ever targets the
 * final key, so a late re-PUT to the upload URL cannot touch the pinned copy;
 * leftovers under uploads/ expire by lifecycle.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MoovError, moovFetch, scopes } from '../parity/moov-client.mjs';
import { OnboardingError } from './crypto.mjs';
import { isNetworkError, moovErrorCode, onboardingLog } from './redact.mjs';
import { completeOutbox, enqueueOutbox, failOutboxAttempt, loadAccount, publicDocument } from './store.mjs';

export const DOCUMENTS_KMS_KEY_ENV = 'COMPLIANCE_DOCUMENTS_KMS_KEY_ARN';
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_URL_EXPIRES_SECONDS = 300;
export const VIEW_URL_EXPIRES_SECONDS = 60;

/** Same values as src/lib/payments/verificationFiles.ts FILE_PURPOSE_OPTIONS. */
export const DOCUMENT_PURPOSES = Object.freeze([
  'business_verification',
  'identity_verification',
  'individual_verification',
  'representative_verification',
  'w9',
  'bank_statement',
  'license',
  'insurance',
  'saas_agreement',
  'terms_of_service',
  'privacy_policy',
]);

/** Moov filePurpose for each ChecksOps purpose; the ChecksOps purpose rides in metadata. */
export const MOOV_FILE_PURPOSE = Object.freeze({
  business_verification: 'business_verification',
  identity_verification: 'identity_verification',
  individual_verification: 'individual_verification',
  representative_verification: 'representative_verification',
  w9: 'business_verification',
  bank_statement: 'business_verification',
  license: 'business_verification',
  insurance: 'business_verification',
  saas_agreement: 'business_verification',
  terms_of_service: 'business_verification',
  privacy_policy: 'business_verification',
});

const EXTENSION_TYPES = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  csv: 'text/csv',
});

const CONTENT_TYPE_ALIASES = Object.freeze({
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'text/csv': 'text/csv',
  'application/csv': 'text/csv',
  'application/vnd.ms-excel': 'text/csv',
});

export const ALLOWED_CONTENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'text/csv']);

const filesBucket = () => String(process.env.FILES_BUCKET || '').trim();
export const documentsKeyArn = () => String(process.env[DOCUMENTS_KMS_KEY_ENV] || '').trim();

/**
 * S3 client for compliance documents. Checksums only when S3 requires them:
 * with the SDK default (WHEN_SUPPORTED) a presigned PUT carries
 * x-amz-checksum-crc32 for an empty body and S3 rejects the browser upload.
 */
export const DOCUMENTS_S3_CONFIG = Object.freeze({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
export const createDocumentsS3Client = (extra = {}) => new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  ...DOCUMENTS_S3_CONFIG,
  ...extra,
});
let defaultS3 = null;
const s3Of = (deps) => {
  if (deps.s3) return deps.s3;
  if (!defaultS3) defaultS3 = createDocumentsS3Client();
  return defaultS3;
};

/** Pending (issued, not finalized) upload rows allowed per tenant per day. */
export const MAX_PENDING_UPLOADS = 50;

/**
 * Dedicated prefix outside every generic storage bucket mapping
 * (files/{bucket}/...), so generic storage can never resolve it and the
 * bucket policy / lifecycle rule can target it with a fixed prefix.
 */
export const DOCUMENTS_PREFIX = 'files/verification-docs/';
export const documentStorageKey = (tenantId, documentId) => `${DOCUMENTS_PREFIX}uploads/${tenantId}/${documentId}`;
export const documentFinalKey = (tenantId, documentId) => `${DOCUMENTS_PREFIX}final/${tenantId}/${documentId}`;

export const sanitizeFileName = (value) => {
  const base = String(value ?? '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 200);
  return clean || null;
};

/** Validates the upload request; returns the canonical content type. */
export function validateUploadRequest({ purpose, file_name: fileName, content_type: contentType, size }) {
  if (!DOCUMENT_PURPOSES.includes(String(purpose || ''))) {
    throw new OnboardingError('invalid_document_purpose', 400, { field: 'purpose' });
  }
  const name = sanitizeFileName(fileName);
  if (!name) throw new OnboardingError('invalid_file_name', 400, { field: 'file_name' });
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const fromExt = EXTENSION_TYPES[ext];
  if (!fromExt) throw new OnboardingError('unsupported_document_type', 400, { field: 'file_name', allowed: Object.keys(EXTENSION_TYPES) });
  const canonical = CONTENT_TYPE_ALIASES[String(contentType || '').toLowerCase().split(';')[0].trim()];
  if (!canonical || canonical !== fromExt) {
    throw new OnboardingError('unsupported_document_type', 400, { field: 'content_type', allowed: ALLOWED_CONTENT_TYPES });
  }
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_DOCUMENT_BYTES) {
    throw new OnboardingError('invalid_document_size', 400, { field: 'size', max: MAX_DOCUMENT_BYTES });
  }
  return { purpose: String(purpose), fileName: name, contentType: canonical, size: bytes };
}

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

const looksLikeCsv = (bytes) => {
  if (!bytes.length) return false;
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return true;
};

/** Content type from file signature, or null. */
export function sniffContentType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (looksLikeCsv(b)) return 'text/csv';
  return null;
}

const requireStorageConfig = () => {
  const bucket = filesBucket();
  const keyArn = documentsKeyArn();
  if (!bucket || !keyArn) throw new OnboardingError('document_storage_unavailable', 503);
  return { bucket, keyArn };
};

const kmsKeyMatches = (reported, configured) => {
  if (!reported || !configured) return false;
  if (reported === configured) return true;
  const id = (value) => String(value).split('/').pop();
  return id(reported) === id(configured);
};

export async function createUploadUrl(client, ctx, body, deps = {}) {
  const request = validateUploadRequest(body || {});
  const { bucket, keyArn } = requireStorageConfig();
  const pending = Number((await client.query(
    `SELECT count(*)::int AS pending FROM public.moov_compliance_documents
     WHERE tenant_id = $1::uuid AND environment = $2 AND status = 'pending_upload'
       AND upload_url_issued_at > now() - interval '1 day'`,
    [ctx.tenantId, ctx.environment],
  )).rows[0]?.pending ?? 0);
  if (pending >= MAX_PENDING_UPLOADS) {
    throw new OnboardingError('too_many_pending_uploads', 429, { max: MAX_PENDING_UPLOADS });
  }
  let representativeId = null;
  if (body?.representative_id !== undefined && body?.representative_id !== null && body?.representative_id !== '') {
    const rid = String(body.representative_id);
    const rep = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rid) ? (await client.query(
      `SELECT id FROM public.moov_onboarding_representatives
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = $3 AND removed_at IS NULL LIMIT 1`,
      [rid, ctx.tenantId, ctx.environment],
    )).rows[0] : null;
    if (!rep) throw new OnboardingError('invalid_representative_id', 400, { field: 'representative_id' });
    representativeId = rep.id;
  }
  const documentId = randomUUID();
  const key = documentStorageKey(ctx.tenantId, documentId);
  const row = (await client.query(
    `INSERT INTO public.moov_compliance_documents
      (id, tenant_id, environment, purpose, file_name, content_type, size_bytes,
       storage_key, kms_key_arn, status, uploaded_by, upload_url_issued_at, representative_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, 'pending_upload', $10::uuid, now(), $11::uuid)
     RETURNING *`,
    [documentId, ctx.tenantId, ctx.environment, request.purpose, request.fileName,
      request.contentType, request.size, key, keyArn, ctx.userId, representativeId],
  )).rows[0];
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: request.contentType,
    ContentLength: request.size,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: keyArn,
  });
  const sign = deps.getSignedUrl || getSignedUrl;
  const uploadUrl = await sign(s3Of(deps), command, {
    expiresIn: UPLOAD_URL_EXPIRES_SECONDS,
    // Exact type and length are part of the signature; the SSE-KMS headers must
    // be sent as headers (not query) so S3 enforces them on the PUT.
    signableHeaders: new Set(['content-type', 'content-length']),
    unhoistableHeaders: new Set(['x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']),
  });
  return {
    document_id: row.id,
    upload_url: uploadUrl,
    method: 'PUT',
    expires_in: UPLOAD_URL_EXPIRES_SECONDS,
    headers: {
      'Content-Type': request.contentType,
      'Content-Length': String(request.size),
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': keyArn,
    },
    document: publicDocument(row),
  };
}

const bodyBytes = async (body) => {
  if (!body) return new Uint8Array();
  if (typeof body.transformToByteArray === 'function') return body.transformToByteArray();
  if (body instanceof Uint8Array) return body;
  if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
};

/**
 * Permanently removes the rejected version (a versioned bucket would otherwise
 * keep it behind a delete marker). Without a version id, falls back to a plain delete.
 */
const deleteStoredVersion = async (deps, bucket, key, versionId) => {
  try {
    await s3Of(deps).send(new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
  } catch { /* the object stays private and unreferenced; the row is not marked stored */ }
};

/**
 * Reads one object version back and checks it against the row.
 * - Already finalized: the final key at the pinned version.
 * - First finalize: the upload key's current version; if the upload was
 *   already promoted (a previous attempt rolled back after the copy), the
 *   final key's current version, which only the server ever writes.
 */
export async function verifyStoredObject(row, deps = {}) {
  const { bucket, keyArn } = requireStorageConfig();
  const s3 = s3Of(deps);
  const finalKey = row.final_storage_key || documentFinalKey(row.tenant_id, row.id);
  const pinned = row.final_storage_key && row.s3_version_id ? row.s3_version_id : null;
  let key = pinned ? finalKey : row.storage_key;
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(pinned ? { VersionId: pinned } : {}) }));
  } catch {
    if (pinned) throw new OnboardingError('document_version_missing', 409);
    try {
      key = finalKey;
      head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      throw new OnboardingError('document_not_uploaded', 409);
    }
  }
  const promoted = key === finalKey;
  const versionId = head?.VersionId || null;
  if (!versionId) throw new OnboardingError('document_version_missing', 409);
  if (pinned && versionId !== pinned) throw new OnboardingError('document_version_mismatch', 409);
  const reject = async (code) => {
    // Only a not-yet-accepted upload version is removed (permanently, by version).
    if (!promoted) await deleteStoredVersion(deps, bucket, key, versionId);
    throw new OnboardingError(code, 422);
  };
  const size = Number(row.size_bytes);
  if (Number(head?.ContentLength) !== size) await reject('document_size_mismatch');
  if (String(head?.ContentType || '').toLowerCase().split(';')[0].trim() !== row.content_type) await reject('document_type_mismatch');
  if (head?.ServerSideEncryption !== 'aws:kms' || !kmsKeyMatches(head?.SSEKMSKeyId, keyArn)) await reject('document_encryption_mismatch');
  const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const bytes = await bodyBytes(got?.Body);
  if (bytes.length !== size || bytes.length > MAX_DOCUMENT_BYTES) await reject('document_size_mismatch');
  if (sniffContentType(bytes) !== row.content_type) await reject('document_content_mismatch');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (row.sha256 && row.sha256 !== sha256) throw new OnboardingError('document_version_mismatch', 409);
  return { bytes, sha256, versionId, key, promoted };
}

/**
 * Copies the verified upload version to the final key (SSE-KMS, dedicated
 * key) and permanently deletes that upload version. Returns the final version.
 */
export async function promoteToFinal(row, verified, deps = {}) {
  const { bucket, keyArn } = requireStorageConfig();
  const s3 = s3Of(deps);
  const finalKey = documentFinalKey(row.tenant_id, row.id);
  let copied;
  try {
    copied = await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      CopySource: `${bucket}/${verified.key}?versionId=${encodeURIComponent(verified.versionId)}`,
      MetadataDirective: 'COPY',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: keyArn,
    }));
  } catch {
    throw new OnboardingError('document_promote_failed', 503);
  }
  const finalVersion = copied?.VersionId || null;
  if (!finalVersion) throw new OnboardingError('document_version_missing', 409);
  await deleteStoredVersion(deps, bucket, verified.key, verified.versionId);
  return { finalKey, finalVersion };
}

/**
 * POST /accounts/{id}/files as multipart/form-data, idempotent per document and account: a document
 * sent again to a replacement account is never answered from the gone account's upload.
 */
export async function sendDocumentToMoov({ accountId, row, bytes, environment, fetchImpl }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: row.content_type }), row.file_name);
  form.append('filePurpose', MOOV_FILE_PURPOSE[row.purpose] || 'business_verification');
  form.append('metadata', JSON.stringify({
    checksops_document_id: row.id,
    checksops_purpose: row.purpose,
    ...(row.representative_id ? { checksops_representative_id: row.representative_id } : {}),
  }));
  return moovFetch(`/accounts/${accountId}/files`, {
    method: 'POST',
    scopes: scopes.filesWrite(accountId),
    idempotencyKey: `checksops-file-${environment}-${row.id}-${createHash('sha256').update(JSON.stringify(accountId)).digest('hex').slice(0, 12)}`,
    formData: form,
    fetchImpl,
  });
}

/**
 * Verify, then send to Moov. Retryable: a document already sent returns as is
 * (completing its outbox row); a Moov failure leaves it stored with a pending
 * outbox row.
 */
export async function finalizeDocument(client, ctx, row, { deps = {}, fetchImpl, outboxId = null } = {}) {
  if (row.moov_file_id) {
    if (outboxId) await completeOutbox(client, { id: outboxId });
    return { document: publicDocument(row), moov_synced: true, pending: false };
  }
  const verified = await verifyStoredObject(row, deps);
  const { bytes, sha256 } = verified;
  let pin = row.final_storage_key && row.s3_version_id
    ? { finalKey: row.final_storage_key, finalVersion: row.s3_version_id }
    : null;
  if (!pin) {
    pin = verified.promoted
      ? { finalKey: verified.key, finalVersion: verified.versionId }
      : await promoteToFinal(row, verified, deps);
  }
  let stored = (await client.query(
    `UPDATE public.moov_compliance_documents
     SET status = CASE WHEN status = 'pending_upload' THEN 'stored' ELSE status END,
         sha256 = $2, final_storage_key = COALESCE(final_storage_key, $3),
         s3_version_id = COALESCE(s3_version_id, $4),
         uploaded_at = COALESCE(uploaded_at, now()), updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [row.id, sha256, pin.finalKey, pin.finalVersion],
  )).rows[0] || row;

  const queued = outboxId ? { id: outboxId } : await enqueueOutbox(client, {
    tenantId: ctx.tenantId, environment: ctx.environment, kind: 'document_upload', subjectId: row.id,
    userId: ctx.userId, payload: { document_id: row.id },
  });

  const account = await loadAccount(client, ctx.tenantId, ctx.environment);
  if (!account?.provider_account_id) {
    await failOutboxAttempt(client, { id: queued.id, errorCode: 'moov_account_missing' });
    await client.query(
      `UPDATE public.moov_compliance_documents SET last_error_code = 'moov_account_missing', moov_status = 'sync_failed', updated_at = now() WHERE id = $1::uuid`,
      [row.id],
    );
    return { document: publicDocument(stored), moov_synced: false, pending: true, error_code: 'moov_account_missing' };
  }
  try {
    const uploaded = await sendDocumentToMoov({
      accountId: account.provider_account_id, row: stored, bytes, environment: ctx.environment, fetchImpl,
    });
    const fileId = uploaded?.fileID ?? uploaded?.fileId ?? null;
    if (!fileId) throw new OnboardingError('moov_file_id_missing', 502);
    stored = (await client.query(
      `UPDATE public.moov_compliance_documents
       SET status = 'sent', moov_file_id = $2, moov_status = $3, moov_account_id = $4,
           last_error_code = NULL, sent_at = now(), updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      [row.id, fileId, String(uploaded?.fileStatus ?? uploaded?.status ?? 'pending').toLowerCase().slice(0, 40), account.provider_account_id],
    )).rows[0] || stored;
    await completeOutbox(client, { id: queued.id });
    return { document: publicDocument(stored), moov_synced: true, pending: false };
  } catch (error) {
    if (!(error instanceof OnboardingError) && !(error instanceof MoovError) && !isNetworkError(error)) throw error;
    const code = error instanceof OnboardingError ? error.code : moovErrorCode(error);
    await failOutboxAttempt(client, { id: queued.id, errorCode: code });
    await client.query(
      `UPDATE public.moov_compliance_documents SET last_error_code = $2, moov_status = 'sync_failed', updated_at = now() WHERE id = $1::uuid`,
      [row.id, code],
    );
    onboardingLog('moov_document_send_failed', { tenant: ctx.tenantId, environment: ctx.environment, document: row.id, error_code: code });
    return { document: publicDocument(stored), moov_synced: false, pending: true, error_code: code };
  }
}

/** Short-lived GET pinned to the verified version. */
export async function viewUrl(row, deps = {}) {
  if (!row || !['stored', 'sent'].includes(row.status) || !row.s3_version_id || !row.final_storage_key) {
    throw new OnboardingError('document_not_available', 404);
  }
  const { bucket } = requireStorageConfig();
  const sign = deps.getSignedUrl || getSignedUrl;
  const safeName = String(row.file_name || 'document').replace(/[^A-Za-z0-9._ -]/g, '_');
  const url = await sign(s3Of(deps), new GetObjectCommand({
    Bucket: bucket,
    Key: row.final_storage_key,
    VersionId: row.s3_version_id,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ResponseContentType: row.content_type,
  }), { expiresIn: VIEW_URL_EXPIRES_SECONDS });
  return { url, expires_in: VIEW_URL_EXPIRES_SECONDS, file_name: row.file_name, content_type: row.content_type };
}
