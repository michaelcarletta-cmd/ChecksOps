import { createHash } from 'node:crypto';
import pg from 'pg';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import { parseBody, ignoredSpoof, withIdentity } from './data.mjs';
import {
  APP_BUCKET_SET,
  PUBLIC_BRANDING_BUCKETS,
  SKIP_BUCKET_SET,
  normalizePath,
  pathCandidates,
  s3KeyFor,
} from './storage-paths.mjs';
import { MORTGAGE_LIBRARY_STORAGE_AUTH_SQL } from './mortgage-library-docs.mjs';

const { Client } = pg;

const DEFAULT_EXPIRES = 300;
const MAX_EXPIRES = 300;
const MIN_EXPIRES = 30;
/** Public signing sessions keep the PDF open; authenticated check/document views stay ≤300s. */
export const SIGNING_DOCUMENT_EXPIRES = 1800;

const filesBucket = () => process.env.FILES_BUCKET || '';

const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

export const clampExpires = (value, fallback = DEFAULT_EXPIRES, max = MAX_EXPIRES) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(MIN_EXPIRES, Math.floor(n)));
};

const columnMatchSql = (table, columns) => {
  const tests = columns.map((col) => `(${col} = ANY($1::text[]) OR split_part(${col}, '?', 1) LIKE '%' || $2)`);
  return `SELECT 1 FROM ${table} WHERE ${tests.join(' OR ')} LIMIT 1`;
};

const depositSibling = (column, suffix) =>
  `regexp_replace(split_part(COALESCE(${column}, ''), '?', 1), '\\.[^.]+$', '') || '${suffix}' = $2`;

/** Read auth for check images, endorsed deposit JPEGs, `.deposit2.jpg`, and `.checkalt.jpg` siblings. */
export const CHECK_INTAKE_CLAIM_FILES_AUTH_SQL = `SELECT 1 FROM check_intake_items WHERE ${[
  '(front_image_path = ANY($1::text[]) OR split_part(front_image_path, \'?\', 1) LIKE \'%\' || $2)',
  '(back_image_path = ANY($1::text[]) OR split_part(back_image_path, \'?\', 1) LIKE \'%\' || $2)',
  '(back_image_original_path = ANY($1::text[]) OR split_part(back_image_original_path, \'?\', 1) LIKE \'%\' || $2)',
  '(back_image_deposit_path = ANY($1::text[]) OR split_part(back_image_deposit_path, \'?\', 1) LIKE \'%\' || $2)',
  `(${depositSibling('front_image_path', '.deposit2.jpg')} OR ${depositSibling('back_image_path', '.deposit2.jpg')} OR ${depositSibling('back_image_original_path', '.deposit2.jpg')} OR ${depositSibling('back_image_deposit_path', '.deposit2.jpg')})`,
  `(${depositSibling('front_image_path', '.checkalt.jpg')} OR ${depositSibling('back_image_path', '.checkalt.jpg')} OR ${depositSibling('back_image_original_path', '.checkalt.jpg')} OR ${depositSibling('back_image_deposit_path', '.checkalt.jpg')})`,
].join(' OR ')} LIMIT 1`;

export const BUCKET_AUTH_SQL = {
  'claim-files': [
    columnMatchSql('check_files', ['file_path']),
    columnMatchSql('claim_files', ['file_path']),
    CHECK_INTAKE_CLAIM_FILES_AUTH_SQL,
    columnMatchSql('homeowner_check_uploads', ['file_path']),
    columnMatchSql('signature_requests', ['document_path', 'final_pdf_path']),
    columnMatchSql('cash_job_attachments', ['file_path']),
  ],
  'endorsement-packets': [
    columnMatchSql('check_intake_items', ['endorsement_packet_path']),
  ],
  'deposit-attachments': [
    columnMatchSql('deposit_attachments', ['file_path']),
  ],
  'loss-draft-documents': [
    columnMatchSql('loss_draft_documents', ['file_path']),
  ],
  'tenant-documents': [
    columnMatchSql('tenant_documents', ['file_path']),
  ],
  'homeowner-uploads': [
    columnMatchSql('homeowner_ledger_check_uploads', ['front_path', 'back_path']),
  ],
  'tenant-logos': [
    columnMatchSql('tenants', ['logo_url']),
  ],
  'company-branding': [
    columnMatchSql('company_branding', ['letterhead_url']),
  ],
  'contractor-documents': [],
  'document-templates': [
    columnMatchSql('tenant_documents', ['file_path']),
  ],
  'email-assets': [
    columnMatchSql('tenants', ['logo_url']),
  ],
  'claim-files-backup': [],
};

/** Attachment-gated Mortgage Ops read. Not a general tenant_documents grant. */
export { MORTGAGE_LIBRARY_STORAGE_AUTH_SQL };

export const LIST_SQL = {
  'claim-files': [
    `SELECT file_path AS path, file_name AS name, file_type AS mimetype, file_size AS size, created_at FROM check_files WHERE split_part(file_path, '?', 1) LIKE '%' || $1 LIMIT 100`,
    `SELECT file_path AS path, file_name AS name, file_type AS mimetype, file_size AS size, created_at FROM claim_files WHERE split_part(file_path, '?', 1) LIKE '%' || $1 LIMIT 100`,
    `SELECT COALESCE(front_image_path, back_image_path, back_image_original_path, back_image_deposit_path) AS path, NULL::text AS name, NULL::text AS mimetype, NULL::bigint AS size, created_at
     FROM check_intake_items
     WHERE front_image_path LIKE '%' || $1
        OR back_image_path LIKE '%' || $1
        OR back_image_original_path LIKE '%' || $1
        OR back_image_deposit_path LIKE '%' || $1
     LIMIT 100`,
  ],
  'endorsement-packets': [
    `SELECT endorsement_packet_path AS path, NULL::text AS name, 'image/svg+xml'::text AS mimetype, NULL::bigint AS size, created_at FROM check_intake_items WHERE endorsement_packet_path LIKE '%' || $1 LIMIT 100`,
  ],
  'deposit-attachments': [
    `SELECT file_path AS path, file_name AS name, NULL::text AS mimetype, file_size AS size, created_at FROM deposit_attachments WHERE file_path LIKE '%' || $1 LIMIT 100`,
  ],
  'loss-draft-documents': [
    `SELECT file_path AS path, file_name AS name, NULL::text AS mimetype, NULL::bigint AS size, created_at FROM loss_draft_documents WHERE file_path LIKE '%' || $1 LIMIT 100`,
  ],
  'tenant-documents': [
    `SELECT file_path AS path, file_name AS name, mime_type AS mimetype, file_size AS size, created_at FROM tenant_documents WHERE file_path LIKE '%' || $1 LIMIT 100`,
  ],
  'homeowner-uploads': [
    `SELECT front_path AS path, NULL::text AS name, NULL::text AS mimetype, NULL::bigint AS size, created_at FROM homeowner_ledger_check_uploads WHERE front_path LIKE '%' || $1 OR back_path LIKE '%' || $1 LIMIT 100`,
  ],
  'tenant-logos': [
    `SELECT logo_url AS path, NULL::text AS name, NULL::text AS mimetype, NULL::bigint AS size, created_at FROM tenants WHERE logo_url LIKE '%' || $1 LIMIT 20`,
  ],
};

const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });

const denyBucket = (bucket) => {
  if (!bucket || SKIP_BUCKET_SET.has(bucket) || !APP_BUCKET_SET.has(bucket)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'bucket_not_allowed',
      message: 'Bucket is not in the ChecksOps application storage map',
    };
  }
  return null;
};

export const authorizeObject = async (client, bucket, objectPath, { userId } = {}) => {
  const relRaw = normalizePath(objectPath, bucket);
  if (!relRaw) return { authorized: false, reason: 'invalid_path' };
  const rel = relRaw.split('?')[0];
  if (!rel) return { authorized: false, reason: 'invalid_path' };
  const candidates = pathCandidates(bucket, objectPath);
  const queries = BUCKET_AUTH_SQL[bucket] || [];
  for (const sql of queries) {
    const result = await client.query(sql, [candidates, rel]);
    if (result.rows.length) return { authorized: true, rel, candidates };
  }
  if (bucket === 'tenant-documents' && userId) {
    const attached = await client.query(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL, [candidates, rel, userId]);
    if (attached.rows.length) {
      return { authorized: true, rel, candidates, via: 'mortgage_request_library_documents' };
    }
  }
  return { authorized: false, reason: 'not_authorized', rel, candidates };
};

const presignGet = async (deps, key, { expiresIn, downloadName, contentType, maxExpires } = {}) => {
  const sign = deps.getSignedUrl || getSignedUrl;
  const s3 = defaultS3(deps);
  const command = new GetObjectCommand({
    Bucket: filesBucket(),
    Key: key,
    ResponseContentDisposition: downloadName
      ? `attachment; filename="${String(downloadName).replace(/"/g, '')}"`
      : undefined,
    ResponseContentType: contentType || undefined,
  });
  const signedUrl = await sign(s3, command, {
    expiresIn: clampExpires(expiresIn, DEFAULT_EXPIRES, maxExpires || MAX_EXPIRES),
  });
  return signedUrl;
};

const objectExists = async (deps, key) => {
  const s3 = defaultS3(deps);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: filesBucket(), Key: key }));
    return true;
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode || error?.statusCode;
    if (status === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') return false;
    throw error;
  }
};

export const handleStorageSign = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const bucket = String(body.bucket || '').trim();
  const denied = denyBucket(bucket);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  const objectPath = body.path || body.paths?.[0];
  const auth = await authorizeObject(client, bucket, objectPath, { userId: mapping.application_user_id });
  if (!auth.authorized) {
    return {
      ok: false,
      statusCode: 403,
      error: 'storage_forbidden',
      message: 'Not authorized for this object',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  }
  const key = s3KeyFor(bucket, auth.rel);
  const exists = await objectExists(deps, key);
  if (!exists) {
    return {
      ok: false,
      statusCode: 404,
      error: 'object_not_in_s3',
      message: 'Authorized object is not present in staging S3',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }
  const expiresIn = clampExpires(body.expiresIn || body.expires_in);
  const downloadName = body.download === true
    ? auth.rel.split('/').pop()
    : (typeof body.download === 'string' ? body.download : null);
  const signedUrl = await presignGet(deps, key, { expiresIn, downloadName });
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    ok: true,
    statusCode: 200,
    bucket,
    path: auth.rel,
    signedUrl,
    signedUrlExpiresAt: expiresAt,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
  };
}, deps);

export const handleStorageSignMany = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const bucket = String(body.bucket || '').trim();
  const denied = denyBucket(bucket);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 50) : [];
  const expiresIn = clampExpires(body.expiresIn || body.expires_in, DEFAULT_EXPIRES);
  const data = [];
  for (const objectPath of paths) {
    const auth = await authorizeObject(client, bucket, objectPath, { userId: mapping.application_user_id });
    if (!auth.authorized) {
      data.push({ path: objectPath, signedUrl: null, error: 'storage_forbidden' });
      continue;
    }
    const key = s3KeyFor(bucket, auth.rel);
    try {
      if (!(await objectExists(deps, key))) {
        data.push({ path: auth.rel, signedUrl: null, error: 'object_not_in_s3' });
        continue;
      }
      const signedUrl = await presignGet(deps, key, { expiresIn });
      data.push({ path: auth.rel, signedUrl, error: null });
    } catch (error) {
      data.push({ path: auth.rel, signedUrl: null, error: sanitizePublicError(error) });
    }
  }
  return {
    ok: true,
    statusCode: 200,
    data,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
  };
}, deps);

export const handleStorageList = async (event, deps = {}) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const bucket = String(body.bucket || '').trim();
  const denied = denyBucket(bucket);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  const prefix = normalizePath(body.prefix || body.path || '', bucket) || '';
  const queries = LIST_SQL[bucket] || [];
  const rows = [];
  for (const sql of queries) {
    await client.query('SAVEPOINT storage_list');
    try {
      const result = await client.query(sql, [prefix]);
      rows.push(...result.rows);
      await client.query('RELEASE SAVEPOINT storage_list');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT storage_list');
    }
  }
  const data = rows.map((row) => {
    const rel = normalizePath(row.path, bucket) || String(row.path || '');
    return {
      name: rel.startsWith(prefix) && prefix ? rel.slice(prefix.length).replace(/^\//, '') : (rel.split('/').pop() || rel),
      id: rel,
      created_at: row.created_at || null,
      metadata: {
        mimetype: row.mimetype || null,
        size: row.size || null,
      },
    };
  });
  return {
    ok: true,
    statusCode: 200,
    data,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
  };
}, deps);

export const handleStorageDownload = async (event, deps = {}) => {
  const signed = await handleStorageSign(event, deps);
  if (!signed.ok) return signed;
  return {
    ...signed,
    download: true,
  };
};

const publicClient = async (deps) => {
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const credentials = await loadCredentials();
  const client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 8000 }));
  await client.connect();
  return client;
};

export const isPublicBrandingPath = async (client, bucket, rel) => {
  if (!PUBLIC_BRANDING_BUCKETS.includes(bucket)) return false;
  if (bucket === 'email-assets') return rel === 'checksops-logo.png';
  if (bucket === 'tenant-logos') {
    const result = await client.query(
      `SELECT 1 FROM tenants_public WHERE logo_url IS NOT NULL AND split_part(logo_url, '?', 1) LIKE '%' || $1 LIMIT 1`,
      [rel],
    );
    return result.rows.length > 0;
  }
  if (bucket === 'company-branding') {
    const branding = await client.query(
      `SELECT 1 FROM public.company_branding
       WHERE split_part(COALESCE(letterhead_url, ''), '?', 1) LIKE '%' || $1
       LIMIT 1`,
      [rel],
    );
    if (branding.rows.length) return true;
    const tenants = await client.query(
      `SELECT 1 FROM public.tenants
       WHERE split_part(COALESCE(invoice_letterhead_url, ''), '?', 1) LIKE '%' || $1
          OR split_part(COALESCE(logo_url, ''), '?', 1) LIKE '%' || $1
       LIMIT 1`,
      [rel],
    );
    return tenants.rows.length > 0;
  }
  return false;
};

export const handleStoragePublic = async (event, deps = {}) => {
  const query = event?.queryStringParameters || {};
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const bucket = String(query.bucket || body.bucket || '').trim();
  const objectPath = String(query.path || body.path || '').trim();
  const denied = denyBucket(bucket);
  if (denied) return { ...denied, spoofFieldsIgnored: spoof };
  const rel = normalizePath(objectPath, bucket);
  if (!rel) {
    return { ok: false, statusCode: 400, error: 'invalid_path', spoofFieldsIgnored: spoof };
  }
  let client;
  try {
    client = await publicClient(deps);
    const allowed = await isPublicBrandingPath(client, bucket, rel);
    if (!allowed) {
      return {
        ok: false,
        statusCode: 403,
        error: 'storage_forbidden',
        message: 'Not a public branding object',
        spoofFieldsIgnored: spoof,
      };
    }
    const key = s3KeyFor(bucket, rel);
    if (!(await objectExists(deps, key))) {
      return { ok: false, statusCode: 404, error: 'object_not_in_s3', spoofFieldsIgnored: spoof };
    }
    const signedUrl = await presignGet(deps, key, { expiresIn: 300 });
    return {
      ok: true,
      statusCode: 302,
      redirect: true,
      location: signedUrl,
      bucket,
      path: rel,
      signedUrl,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    return { ok: false, statusCode: 503, error: 'storage_public_failed', message: sanitizePublicError(error), spoofFieldsIgnored: spoof };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleStorageWritesDisabled = async (event) => {
  const body = parseBody(event);
  return {
    ok: false,
    statusCode: 403,
    error: 'uploads_disabled',
    message: 'Staging storage uploads, deletes, and moves are prepared but not enabled',
    spoofFieldsIgnored: ignoredSpoof(event, body),
  };
};

export const handlePublicSignatureDocument = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const token = String(body.token || '').trim();
  if (!token || token.length < 10) {
    return { ok: false, statusCode: 400, error: 'validate_token', stage: 'validate_token', message: 'Missing or invalid token', spoofFieldsIgnored: spoof };
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  let client;
  try {
    client = await publicClient(deps);
    const row = (await client.query('SELECT public.aws_public_signature_by_token_hash($1) AS doc', [tokenHash])).rows[0]?.doc;
    if (!row) {
      return { ok: false, statusCode: 404, error: 'fetch_signer', stage: 'fetch_signer', message: 'Signature request not found or link has expired', spoofFieldsIgnored: spoof };
    }
    const waitingFor = row.waiting_for || [];
    if (waitingFor.length) {
      return {
        ok: false,
        statusCode: 403,
        stage: 'signer_order_blocked',
        error: `Please wait — ${waitingFor.map((s) => s.name).join(', ')} must sign before you.`,
        waitingFor,
        spoofFieldsIgnored: spoof,
      };
    }
    if (row.signer?.expires_at && new Date(row.signer.expires_at) < new Date()) {
      return { ok: false, statusCode: 403, stage: 'token_expired', error: 'This signing link has expired. Please request a new one.', spoofFieldsIgnored: spoof };
    }
    const documentPath = row.request?.document_path;
    if (!documentPath) {
      return { ok: false, statusCode: 404, stage: 'document_url', error: 'Document not found in storage', spoofFieldsIgnored: spoof };
    }
    const rel = normalizePath(documentPath, 'claim-files');
    const key = s3KeyFor('claim-files', rel);
    if (!key || !(await objectExists(deps, key))) {
      return { ok: false, statusCode: 404, stage: 'document_url', error: 'Document not found in storage', spoofFieldsIgnored: spoof };
    }
    const signedUrl = await presignGet(deps, key, {
      expiresIn: SIGNING_DOCUMENT_EXPIRES,
      maxExpires: SIGNING_DOCUMENT_EXPIRES,
    });
    return {
      ok: true,
      statusCode: 200,
      signer: row.signer,
      request: {
        ...row.request,
        claims: row.claim,
      },
      fields: row.fields || [],
      presets: row.presets || [],
      signedUrl,
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    return { ok: false, statusCode: 503, error: 'signature_lookup_failed', message: sanitizePublicError(error), spoofFieldsIgnored: spoof };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export { handlePublicEndorsement } from './check-endorsement.mjs';

export const handlePublicWritesDisabled = async (event) => ({
  ok: false,
  statusCode: 403,
  error: 'writes_disabled',
  message: 'Public signing submit is disabled on AWS staging during the Storage phase',
  spoofFieldsIgnored: ignoredSpoof(event, parseBody(event)),
});
