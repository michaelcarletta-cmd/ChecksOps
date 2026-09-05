import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_BUCKET_SET, SKIP_BUCKET_SET, s3KeyFor } from '../functions/api/storage-paths.mjs';

export const BRIDGE_TOKEN_SHA256 = 'e5549ea0d88afb24b3b0d7d99db10d6f72a88fa3a724cb8e07d468b11c0625d9';
export const MAX_SIGN_BATCH = 20;
export const LIVE_SIGN_BATCH = 50;
export const PUBLIC_ALREADY_COPIED = new Set(['tenant-logos', 'email-assets']);

export const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

export const sha256Buffer = (buf) => createHash('sha256').update(buf).digest('hex');

export const timingSafeEqualHex = (left, right) => {
  const a = Buffer.from(String(left).toLowerCase());
  const b = Buffer.from(String(right).toLowerCase());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const tokenMatches = (token, expectedSha256 = BRIDGE_TOKEN_SHA256) => (
  Boolean(token) && timingSafeEqualHex(sha256Hex(token), String(expectedSha256).toLowerCase())
);

export const isApprovedMigrationObject = (bucket, name) => {
  if (!APP_BUCKET_SET.has(bucket) || SKIP_BUCKET_SET.has(bucket)) return false;
  if (!name || String(name).includes('..') || String(name).startsWith('Migration/')) return false;
  return true;
};

export const remainingPrivateObjects = (objects) =>
  (objects || []).filter((obj) => (
    isApprovedMigrationObject(obj.bucket, obj.name)
    && !PUBLIC_ALREADY_COPIED.has(obj.bucket)
  ));

export const approvedSourceObjects = (objects) =>
  (objects || []).filter((obj) => isApprovedMigrationObject(obj.bucket, obj.name));

export const keyFingerprint = (key) => sha256Hex(String(key || ''));

export const resolvedDownloadedSize = (downloadedBytes, inventorySize) => {
  if (Number.isFinite(downloadedBytes)) return downloadedBytes;
  if (inventorySize == null || inventorySize === '') return null;
  const n = Number(inventorySize);
  return Number.isFinite(n) ? n : null;
};

export const classifyCopyPreserveExisting = ({ exists, existingHash, sourceHash }) => {
  if (!exists) return { action: 'put', reason: 'not_in_s3' };
  if (existingHash && sourceHash && existingHash === sourceHash) {
    return { action: 'skip_existing', reason: 'hash_match' };
  }
  if (existingHash && sourceHash && existingHash !== sourceHash) {
    return { action: 'conflict', reason: 'hash_mismatch' };
  }
  if (!existingHash) return { action: 'need_dest_hash', reason: 'missing_dest_hash' };
  return { action: 'conflict', reason: 'unverified_existing' };
};

export const supabaseBucketFromS3Key = (key) => {
  const k = String(key || '');
  if (!k.startsWith('files/')) return null;
  const rest = k.slice('files/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return rest || null;
  return rest.slice(0, slash);
};

export const sanitizeCopyRow = (row = {}) => ({
  bucket: row.bucket || null,
  keyHash: row.key ? keyFingerprint(row.key) : (row.keyHash || null),
  reason: row.reason || null,
  bytes: Number.isFinite(row.bytes) ? row.bytes : null,
  status: row.status || null,
});

export const batchesOf = (items, size = MAX_SIGN_BATCH) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const groupByBucket = (objects) => {
  const map = new Map();
  for (const obj of objects || []) {
    if (!map.has(obj.bucket)) map.set(obj.bucket, []);
    map.get(obj.bucket).push(obj);
  }
  return map;
};

export const isBridgeHealthy = (statusCode, body) => (
  Number(statusCode) === 200 && (body?.ok === true || body?.status === 'ok')
);

export const parseSignUrls = (body, bucket) => {
  const rows = body?.urls || body?.signed || [];
  const byName = new Map();
  const failed = [];
  for (const row of rows) {
    const name = row.path || row.name;
    const rowBucket = row.bucket || bucket;
    const url = row.signed_url || row.signedUrl;
    if (row.error || !url) {
      failed.push({ bucket: rowBucket, name, reason: row.error || 'sign_failed' });
      continue;
    }
    byName.set(`${rowBucket}/${name}`, url);
  }
  return { byName, failed };
};

export const destinationKey = (bucket, name) => s3KeyFor(bucket, name);

export const classifyCopy = ({ exists, existingHash, sourceHash }) => {
  if (exists && existingHash && sourceHash && existingHash !== sourceHash) {
    return { action: 'conflict', reason: 'hash_mismatch' };
  }
  if (exists && existingHash && existingHash === sourceHash) {
    return { action: 'skip_existing', reason: 'hash_match' };
  }
  return { action: 'put', reason: exists ? 'missing_dest_hash' : 'not_in_s3' };
};
