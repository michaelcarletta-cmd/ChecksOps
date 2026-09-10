import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ignoredSpoof, parseBody, withIdentity } from './data.mjs';
import { authorizeObject } from './storage.mjs';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  normalizePath,
  s3KeyFor,
} from './storage-paths.mjs';
import { authorizeStorageWritePath } from './storage-write-auth.mjs';
import { storageWritesEnabled } from './write-allowlist.mjs';
import { stampOfficialRearFingerprintIfNeeded } from './providers/production/checkalt-eligibility.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const filesBucket = () => process.env.FILES_BUCKET || '';
const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });

const disabled = (spoof) => ({
  ok: false,
  statusCode: 403,
  error: 'uploads_disabled',
  message: 'Staging storage uploads, deletes, and moves are disabled by AWS_STORAGE_WRITES_ENABLED',
  spoofFieldsIgnored: spoof,
});

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

const authorizeWritePath = async (client, bucket, objectPath, userId) => (
  authorizeStorageWritePath(client, bucket, objectPath, userId)
);

const authorizeDeletePath = async (client, bucket, objectPath, userId) => {
  const writeAuth = await authorizeWritePath(client, bucket, objectPath, userId);
  if (writeAuth.ok) return writeAuth;
  if (writeAuth.error === 'bucket_not_allowed' || writeAuth.error === 'invalid_path') return writeAuth;
  const rel = normalizePath(objectPath, bucket);
  if (!rel) return { ok: false, statusCode: 400, error: 'invalid_path' };
  const existing = await authorizeObject(client, bucket, rel);
  if (!existing.authorized) {
    return {
      ok: false,
      statusCode: 403,
      error: 'storage_forbidden',
      message: 'Not authorized for this object',
    };
  }
  return { ok: true, rel: existing.rel, key: s3KeyFor(bucket, existing.rel), via: 'existing_row' };
};

export const handleStorageUploadUrl = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceStorageWrites === true || storageWritesEnabled();
  if (!enabled) return disabled(spoof);

  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const bucket = String(body.bucket || '').trim();
    const objectPath = body.path || body.paths?.[0];
    const auth = await authorizeWritePath(client, bucket, objectPath, mapping.application_user_id);
    if (!auth.ok) return { ...auth, spoofFieldsIgnored: spoof };

    const contentType = String(body.contentType || body.content_type || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'invalid_field',
        field: 'contentType',
        spoofFieldsIgnored: spoof,
      };
    }
    const contentLength = body.contentLength == null ? null : Number(body.contentLength);
    if (contentLength != null && (!Number.isFinite(contentLength) || contentLength < 1 || contentLength > MAX_UPLOAD_BYTES)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'invalid_field',
        field: 'contentLength',
        spoofFieldsIgnored: spoof,
      };
    }

    const upsert = body.upsert === true || body.upsert === 'true';
    const exists = await objectExists(deps, auth.key);
    if (exists && !upsert) {
      return {
        ok: false,
        statusCode: 409,
        error: 'object_exists',
        message: 'Object already exists; pass upsert=true to overwrite explicitly',
        path: auth.rel,
        spoofFieldsIgnored: spoof,
      };
    }

    if (auth.check) {
      try {
        await stampOfficialRearFingerprintIfNeeded(client, auth.check, auth.rel);
      } catch {
        return {
          ok: false,
          statusCode: 503,
          error: 'provider_rear_fingerprint_stamp_failed',
          message: 'Official rear CheckAlt image could not be bound to current endorsement state',
          spoofFieldsIgnored: spoof,
        };
      }
    }

    const sign = deps.getSignedUrl || getSignedUrl;
    const s3 = defaultS3(deps);
    const command = new PutObjectCommand({
      Bucket: filesBucket(),
      Key: auth.key,
      ContentType: contentType,
    });
    const uploadUrl = await sign(s3, command, { expiresIn: 60 });
    return {
      ok: true,
      statusCode: 200,
      bucket,
      path: auth.rel,
      uploadUrl,
      method: 'PUT',
      requiredHeaders: { 'content-type': contentType },
      expiresIn: 60,
      upsert,
      existed: exists,
      applicationUserId: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
    };
  }, deps);
};

export const handleStorageDelete = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceStorageWrites === true || storageWritesEnabled();
  if (!enabled) return disabled(spoof);

  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const bucket = String(body.bucket || '').trim();
    const paths = Array.isArray(body.paths)
      ? body.paths
      : (body.path ? [body.path] : []);
    if (!paths.length) {
      return { ok: false, statusCode: 400, error: 'missing_required_field', field: 'path', spoofFieldsIgnored: spoof };
    }
    if (paths.length > 20) {
      return { ok: false, statusCode: 400, error: 'invalid_field', field: 'paths', spoofFieldsIgnored: spoof };
    }
    const s3 = defaultS3(deps);
    const deleted = [];
    for (const objectPath of paths) {
      const auth = await authorizeDeletePath(client, bucket, objectPath, mapping.application_user_id);
      if (!auth.ok) return { ...auth, spoofFieldsIgnored: spoof };
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: filesBucket(), Key: auth.key }));
      } catch {
        return {
          ok: false,
          statusCode: 503,
          error: 'storage_delete_failed',
          message: 'Authorized delete could not be completed',
          spoofFieldsIgnored: spoof,
        };
      }
      deleted.push(auth.rel);
    }
    return {
      ok: true,
      statusCode: 200,
      bucket,
      deleted,
      applicationUserId: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
    };
  }, deps);
};

export const handleStorageMove = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceStorageWrites === true || storageWritesEnabled();
  if (!enabled) return disabled(spoof);

  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const bucket = String(body.bucket || '').trim();
    const fromPath = body.from || body.source || body.path;
    const toPath = body.to || body.destination;
    const fromAuth = await authorizeDeletePath(client, bucket, fromPath, mapping.application_user_id);
    if (!fromAuth.ok) return { ...fromAuth, spoofFieldsIgnored: spoof, field: 'from' };
    const toAuth = await authorizeWritePath(client, bucket, toPath, mapping.application_user_id);
    if (!toAuth.ok) return { ...toAuth, spoofFieldsIgnored: spoof, field: 'to' };
    if (fromAuth.rel === toAuth.rel) {
      return { ok: false, statusCode: 400, error: 'invalid_field', field: 'to', message: 'source and destination are the same', spoofFieldsIgnored: spoof };
    }
    const upsert = body.upsert === true || body.upsert === 'true';
    if ((await objectExists(deps, toAuth.key)) && !upsert) {
      return {
        ok: false,
        statusCode: 409,
        error: 'object_exists',
        message: 'Destination already exists; pass upsert=true to overwrite explicitly',
        path: toAuth.rel,
        spoofFieldsIgnored: spoof,
      };
    }
    const s3 = defaultS3(deps);
    const copySource = `${filesBucket()}/${fromAuth.key}`;
    try {
      await s3.send(new CopyObjectCommand({
        Bucket: filesBucket(),
        CopySource: encodeURI(copySource),
        Key: toAuth.key,
      }));
      await s3.send(new DeleteObjectCommand({ Bucket: filesBucket(), Key: fromAuth.key }));
    } catch {
      return {
        ok: false,
        statusCode: 503,
        error: 'storage_move_failed',
        message: 'Authorized move could not be completed',
        spoofFieldsIgnored: spoof,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      bucket,
      from: fromAuth.rel,
      to: toAuth.rel,
      applicationUserId: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
    };
  }, deps);
};
