/**
 * Document Library (Compliance & Docs) services on AWS.
 *
 *   tenant-library-document-create        member saves an uploaded library object as a row
 *   claim-library-documents                member lists the claim tenant's library + shares
 *   homeowner-share-library-document       member shares one library document with one claim
 *   homeowner-share-library-document-revoke  member revokes that share
 *   homeowner-shared-document-url          public: homeowner ledger token -> 5 minute GET URL
 *
 * Owner policy: every member of the tenant (any tenant_users row) is an equal
 * user; tenant_users.role is ignored. Partners, other tenants and the platform
 * owner (without a membership) get nothing.
 *
 * Sharing is per claim (public.homeowner_shared_documents, SQL 94). The old
 * tenant-wide tenant_documents.shared_with_homeowners flag is neither read nor
 * written. Mortgage packet documents (library:mortgage:*) are never shared with
 * homeowners; they go to the Mortgage Desk only (SQL 29).
 */
import pg from 'pg';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import { s3KeyFor } from './storage-paths.mjs';
import { isAllowedTenantDocumentDocType, libraryCategoryOf } from './mortgage-library-doc-types.mjs';
import {
  LIBRARY_BUCKET,
  isLibraryContentType,
  isLibrarySize,
  libraryObjectPath,
  normalizeContentType,
} from './tenant-library-rules.mjs';
import { storageWritesEnabled, writesEnabled } from './write-allowlist.mjs';

const { Client } = pg;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const filesBucket = () => process.env.FILES_BUCKET || '';
const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });

/** Homeowner document links live at most five minutes. */
export const HOMEOWNER_DOCUMENT_URL_SECONDS = 300;

const refuse = (statusCode, error, spoof, extra = {}) => ({ ok: false, statusCode, error, spoofFieldsIgnored: spoof, ...extra });

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) return { error: 'invalid_field' };
  return text.length ? text : null;
};

export const isTenantMember = async (client, userId, tenantId) => {
  if (!isUuid(userId) || !isUuid(tenantId)) return false;
  const rows = (await client.query(
    'SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
    [userId, tenantId],
  )).rows;
  return rows.length > 0;
};

/**
 * Does the claim belong to the tenant? claims.org_id = tenant, or org_id IS NULL
 * and one of the tenant's checks references the claim (the SQL 87/88 rule; SQL
 * 94's share guard enforces the same).
 */
export const claimBelongsToTenant = async (client, claimId, tenantId) => {
  if (!isUuid(claimId) || !isUuid(tenantId)) return false;
  const rows = (await client.query(
    `SELECT 1 FROM public.claims c
      WHERE c.id = $1::uuid
        AND (c.org_id = $2::uuid
          OR (c.org_id IS NULL AND EXISTS (
            SELECT 1 FROM public.check_intake_items i
             WHERE i.claim_id = c.id AND i.tenant_id = $2::uuid)))
      LIMIT 1`,
    [claimId, tenantId],
  )).rows;
  return rows.length > 0;
};

/** The one tenant of the claim the caller is a member of (or the asked one, when it qualifies). */
export const resolveClaimTenantForMember = async (client, userId, claimId, askedTenantId = null) => {
  if (!isUuid(claimId)) return { error: 'invalid_uuid', field: 'claim_id' };
  if (askedTenantId) {
    if (!isUuid(askedTenantId)) return { error: 'invalid_uuid', field: 'tenant_id' };
    if (!(await isTenantMember(client, userId, askedTenantId))) return { error: 'not_authorized' };
    if (!(await claimBelongsToTenant(client, claimId, askedTenantId))) return { error: 'claim_not_in_tenant' };
    return { tenantId: askedTenantId };
  }
  const tenants = (await client.query(
    `SELECT DISTINCT t.tenant_id::text AS tenant_id
       FROM (
         SELECT c.org_id AS tenant_id FROM public.claims c WHERE c.id = $1::uuid AND c.org_id IS NOT NULL
         UNION
         SELECT i.tenant_id FROM public.claims c
           JOIN public.check_intake_items i ON i.claim_id = c.id
          WHERE c.id = $1::uuid AND c.org_id IS NULL AND i.tenant_id IS NOT NULL
       ) t
       JOIN public.tenant_users tu ON tu.tenant_id = t.tenant_id AND tu.user_id = $2::uuid`,
    [claimId, userId],
  )).rows.map((row) => row.tenant_id);
  if (tenants.length === 1) return { tenantId: tenants[0] };
  if (tenants.length > 1) return { error: 'tenant_ambiguous' };
  return { error: 'not_authorized' };
};

const LIBRARY_DOC_SQL = `SELECT id, tenant_id, doc_type, file_name, file_path, mime_type, file_size, created_at
  FROM public.tenant_documents WHERE id = $1::uuid LIMIT 1`;

/** A library document a member may hand to a homeowner or a signer: own tenant, non-mortgage, own library folder. */
export const shareableLibraryDocument = (doc, tenantId) => {
  if (!doc || String(doc.tenant_id).toLowerCase() !== String(tenantId).toLowerCase()) return false;
  const category = libraryCategoryOf(doc.doc_type);
  if (!category || category === 'mortgage') return false;
  return Boolean(libraryObjectPath(doc.file_path, { tenantId, category }));
};

const headObject = async (deps, key) => {
  try {
    const out = await defaultS3(deps).send(new HeadObjectCommand({ Bucket: filesBucket(), Key: key }));
    return { exists: true, size: Number(out?.ContentLength), contentType: normalizeContentType(out?.ContentType) };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode || error?.statusCode;
    if (status === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') return { exists: false };
    throw error;
  }
};

const deleteObjectQuietly = async (deps, key) => {
  try {
    await defaultS3(deps).send(new DeleteObjectCommand({ Bucket: filesBucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
};

/**
 * Save an uploaded library object as a tenant_documents row. The object is
 * read back (HEAD) so the size and type are the stored object's, not the
 * browser's. When the row cannot be saved, the uploaded object is deleted so no
 * orphan stays in S3 (the caller is a member and the key is this tenant's own
 * library key).
 */
export const runTenantLibraryDocumentCreate = async ({ client, mapping, body, spoof, deps = {} }) => {
  const tenantId = body.tenant_id;
  if (!isUuid(tenantId)) return refuse(400, 'invalid_uuid', spoof, { field: 'tenant_id' });
  if (!(await isTenantMember(client, mapping.application_user_id, tenantId))) {
    return refuse(403, 'not_authorized', spoof, { message: 'Membership of this company is required to write library documents' });
  }
  const docType = clip(body.doc_type, 120);
  if (!docType || docType.error || !isAllowedTenantDocumentDocType(docType) || !libraryCategoryOf(docType)) {
    return refuse(400, 'category_not_allowlisted', spoof, { field: 'doc_type' });
  }
  const category = libraryCategoryOf(docType);
  const rel = libraryObjectPath(body.file_path, { tenantId, category });
  if (!rel) {
    return refuse(400, 'path_not_allowlisted', spoof, { field: 'file_path', message: 'file_path must be {tenantId}/library/{category}/{file}' });
  }
  const key = s3KeyFor(LIBRARY_BUCKET, rel);
  // From here on the key is the caller's own; any refusal removes the object.
  const cleanup = async (result) => ({ ...result, orphan_deleted: await deleteObjectQuietly(deps, key) });

  const fileName = clip(body.file_name, 255);
  const notes = clip(body.notes, 2000);
  if (fileName?.error || notes?.error) return cleanup(refuse(400, 'invalid_field', spoof, { field: fileName?.error ? 'file_name' : 'notes' }));

  let head;
  try {
    head = await headObject(deps, key);
  } catch {
    return refuse(503, 'storage_unavailable', spoof);
  }
  if (!head.exists) return refuse(404, 'object_not_in_s3', spoof);
  if (!isLibrarySize(head.size)) return cleanup(refuse(400, 'invalid_field', spoof, { field: 'file_size', message: 'Library files are 1 byte to 25 MB' }));
  if (!isLibraryContentType(head.contentType)) return cleanup(refuse(400, 'invalid_field', spoof, { field: 'mime_type' }));

  const autoShare = category === 'mortgage' && (body.auto_share_mortgage_ops === true || body.auto_share_mortgage_ops === 'true');
  try {
    await client.query('SAVEPOINT tenant_library_insert');
    const rows = (await client.query(
      `INSERT INTO public.tenant_documents (
         tenant_id, doc_type, file_path, file_name, mime_type, file_size,
         auto_share_mortgage_ops, notes, uploaded_by
       ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::bigint, $7::boolean, $8::text, $9::uuid)
       RETURNING *`,
      [tenantId, docType, rel, fileName || rel.split('/').pop(), head.contentType, head.size, autoShare, notes, mapping.application_user_id],
    )).rows;
    await client.query('RELEASE SAVEPOINT tenant_library_insert');
    return { ok: true, statusCode: 200, document: rows[0] || null, spoofFieldsIgnored: spoof };
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT tenant_library_insert'); } catch { /* ignore */ }
    const code = error?.code || null;
    return cleanup(refuse(code === '23514' ? 400 : code === '42501' ? 403 : 503, code === '23514' ? 'category_not_allowlisted' : 'library_insert_failed', spoof, {
      message: sanitizePublicError(error),
    }));
  }
};

export const handleTenantLibraryDocumentCreate = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (deps.forceWrites !== true && !(writesEnabled() && storageWritesEnabled())) {
    return refuse(403, 'writes_disabled', spoof);
  }
  let savedKey = null;
  const result = await withIdentityWrite(event, async (ctx) => {
    const out = await runTenantLibraryDocumentCreate({ ...ctx, deps });
    if (out.ok && out.document?.file_path) savedKey = s3KeyFor(LIBRARY_BUCKET, out.document.file_path);
    return out;
  }, deps);
  // The row was inserted but the transaction did not commit: remove the object too.
  if (savedKey && result?.ok === false) {
    return { ...result, orphan_deleted: await deleteObjectQuietly(deps, savedKey) };
  }
  return result;
};

/** The claim tenant's non-mortgage library and the claim's active shares (for the pickers). */
export const runClaimLibraryDocuments = async ({ client, mapping, body, spoof }) => {
  const resolved = await resolveClaimTenantForMember(client, mapping.application_user_id, body.claim_id, body.tenant_id || null);
  if (resolved.error) return refuse(resolved.error === 'invalid_uuid' ? 400 : 403, resolved.error, spoof, resolved.field ? { field: resolved.field } : {});
  const docs = (await client.query(
    `SELECT id, doc_type, file_name, mime_type, file_size, created_at
       FROM public.tenant_documents
      WHERE tenant_id = $1::uuid AND doc_type LIKE 'library:%' AND doc_type NOT LIKE 'library:mortgage:%'
      ORDER BY created_at DESC
      LIMIT 500`,
    [resolved.tenantId],
  )).rows.map((row) => ({ ...row, category: libraryCategoryOf(row.doc_type) })).filter((row) => row.category);
  let shares = [];
  let sharingAvailable = true;
  await client.query('SAVEPOINT claim_library_shares');
  try {
    shares = (await client.query(
      `SELECT id, tenant_document_id, shared_at
         FROM public.homeowner_shared_documents
        WHERE tenant_id = $1::uuid AND claim_id = $2::uuid AND revoked_at IS NULL
        ORDER BY shared_at DESC`,
      [resolved.tenantId, body.claim_id],
    )).rows;
    await client.query('RELEASE SAVEPOINT claim_library_shares');
  } catch {
    // SQL 94 not applied yet.
    await client.query('ROLLBACK TO SAVEPOINT claim_library_shares');
    sharingAvailable = false;
  }
  return {
    ok: true, statusCode: 200, tenant_id: resolved.tenantId, documents: docs, shares, sharing_available: sharingAvailable, spoofFieldsIgnored: spoof,
  };
};

export const handleClaimLibraryDocuments = (event, deps = {}) => withIdentity(event, (ctx) => runClaimLibraryDocuments(ctx), deps);

const shareInputs = async (client, mapping, body, spoof) => {
  for (const field of ['tenant_id', 'claim_id', 'tenant_document_id']) {
    if (!isUuid(body[field])) return { refusal: refuse(400, 'invalid_uuid', spoof, { field }) };
  }
  if (!(await isTenantMember(client, mapping.application_user_id, body.tenant_id))) {
    return { refusal: refuse(403, 'not_authorized', spoof, { message: 'Membership of this company is required' }) };
  }
  if (!(await claimBelongsToTenant(client, body.claim_id, body.tenant_id))) {
    return { refusal: refuse(403, 'claim_not_in_tenant', spoof) };
  }
  const doc = (await client.query(LIBRARY_DOC_SQL, [body.tenant_document_id])).rows[0];
  if (!shareableLibraryDocument(doc, body.tenant_id)) {
    return { refusal: refuse(403, 'document_not_shareable', spoof) };
  }
  return { doc };
};

export const runHomeownerShareLibraryDocument = async ({ client, mapping, body, spoof }) => {
  const checked = await shareInputs(client, mapping, body, spoof);
  if (checked.refusal) return checked.refusal;
  const inserted = (await client.query(
    `INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
     ON CONFLICT (claim_id, tenant_document_id) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id, tenant_id, claim_id, tenant_document_id, shared_at`,
    [body.tenant_id, body.claim_id, body.tenant_document_id, mapping.application_user_id],
  )).rows[0];
  const share = inserted || (await client.query(
    `SELECT id, tenant_id, claim_id, tenant_document_id, shared_at FROM public.homeowner_shared_documents
      WHERE tenant_id = $1::uuid AND claim_id = $2::uuid AND tenant_document_id = $3::uuid AND revoked_at IS NULL LIMIT 1`,
    [body.tenant_id, body.claim_id, body.tenant_document_id],
  )).rows[0];
  if (!share) return refuse(409, 'share_not_saved', spoof);
  return { ok: true, statusCode: 200, share, created: Boolean(inserted), spoofFieldsIgnored: spoof };
};

export const runHomeownerRevokeLibraryDocument = async ({ client, mapping, body, spoof }) => {
  for (const field of ['tenant_id', 'claim_id', 'tenant_document_id']) {
    if (!isUuid(body[field])) return refuse(400, 'invalid_uuid', spoof, { field });
  }
  if (!(await isTenantMember(client, mapping.application_user_id, body.tenant_id))) {
    return refuse(403, 'not_authorized', spoof, { message: 'Membership of this company is required' });
  }
  if (!(await claimBelongsToTenant(client, body.claim_id, body.tenant_id))) {
    return refuse(403, 'claim_not_in_tenant', spoof);
  }
  const rows = (await client.query(
    `UPDATE public.homeowner_shared_documents
        SET revoked_at = now(), revoked_by = $4::uuid
      WHERE tenant_id = $1::uuid AND claim_id = $2::uuid AND tenant_document_id = $3::uuid AND revoked_at IS NULL
      RETURNING id, revoked_at`,
    [body.tenant_id, body.claim_id, body.tenant_document_id, mapping.application_user_id],
  )).rows;
  return { ok: true, statusCode: 200, revoked: rows.length, spoofFieldsIgnored: spoof };
};

const writeGate = (run) => async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (deps.forceWrites !== true && !writesEnabled()) return refuse(403, 'writes_disabled', spoof);
  return withIdentityWrite(event, (ctx) => run(ctx), deps);
};

export const handleHomeownerShareLibraryDocument = writeGate(runHomeownerShareLibraryDocument);
export const handleHomeownerRevokeLibraryDocument = writeGate(runHomeownerRevokeLibraryDocument);

const connectPublicDb = async (deps) => {
  if (typeof deps.connectPublic === 'function') return deps.connectPublic();
  const credentials = await (deps.loadDatabaseCredentials || loadDatabaseCredentials)();
  const client = (deps.createClient || ((config) => new Client(config)))(buildClientConfig(credentials, { queryTimeoutMillis: 12000 }));
  await client.connect();
  return client;
};

const TOKEN_ERROR_STATUS = Object.freeze({ revoked: 410, expired: 410, not_found: 404, missing_fields: 400 });

/**
 * Public: the homeowner ledger token opens one document shared with the token's
 * own claim. SQL 94's reader applies the token rules (revoked, expired, tenant
 * and claim binding, share revoked); the Lambda then checks the stored path is
 * that tenant's own non-mortgage library key and signs a GET for five minutes.
 */
export const handleHomeownerSharedDocumentUrl = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  const sharedId = body.shared_document_id || body.id;
  if (token.length < 8 || token.length > 200) return refuse(400, 'invalid_token', spoof);
  if (!isUuid(sharedId)) return refuse(400, 'invalid_uuid', spoof, { field: 'shared_document_id' });
  let client;
  try {
    client = await connectPublicDb(deps);
    await client.query('BEGIN READ ONLY');
    const doc = (await client.query(
      'SELECT public.aws_public_homeowner_shared_document($1, $2::uuid) AS doc',
      [token, sharedId],
    )).rows[0]?.doc;
    await client.query('ROLLBACK');
    if (!doc || doc.ok !== true) {
      const error = doc?.error || 'not_found';
      return refuse(TOKEN_ERROR_STATUS[error] || 404, error, spoof);
    }
    const category = String(doc.file_path || '').split('/')[2];
    const rel = libraryObjectPath(doc.file_path, { tenantId: doc.tenant_id, category });
    if (!rel || category === 'mortgage') return refuse(404, 'not_found', spoof);
    const key = s3KeyFor(LIBRARY_BUCKET, rel);
    const name = String(doc.file_name || rel.split('/').pop()).replace(/["\\\r\n]/g, '').slice(0, 200) || 'document';
    const contentType = isLibraryContentType(doc.mime_type) ? normalizeContentType(doc.mime_type) : 'application/octet-stream';
    const sign = deps.getSignedUrl || getSignedUrl;
    const url = await sign(defaultS3(deps), new GetObjectCommand({
      Bucket: filesBucket(),
      Key: key,
      ResponseContentDisposition: `inline; filename="${name}"`,
      ResponseContentType: contentType,
    }), { expiresIn: HOMEOWNER_DOCUMENT_URL_SECONDS });
    return {
      ok: true,
      statusCode: 200,
      url,
      expires_in: HOMEOWNER_DOCUMENT_URL_SECONDS,
      file_name: name,
      mime_type: contentType,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return refuse(503, 'shared_document_failed', spoof, { message: sanitizePublicError(error) });
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

/**
 * The claim's shared documents for the ledger view (SQL 94 reader). Absent
 * until SQL 94 is applied; a SAVEPOINT keeps that from aborting the ledger
 * transaction. Metadata only: no path and no URL.
 */
export const loadSharedDocumentsSafely = async (client, token) => {
  await client.query('SAVEPOINT homeowner_shared_documents');
  try {
    const doc = (await client.query('SELECT public.aws_public_homeowner_shared_documents($1) AS doc', [token])).rows[0]?.doc;
    await client.query('RELEASE SAVEPOINT homeowner_shared_documents');
    if (!doc || doc.ok !== true || !Array.isArray(doc.documents)) return [];
    return doc.documents
      .filter((row) => isUuid(row?.id))
      .map((row) => ({
        id: row.id,
        file_name: row.file_name ?? null,
        mime_type: row.mime_type ?? null,
        file_size: row.file_size ?? null,
        category: row.category ?? null,
        shared_at: row.shared_at ?? null,
      }));
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT homeowner_shared_documents');
    return [];
  }
};
