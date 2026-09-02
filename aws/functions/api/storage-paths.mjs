/**
 * Deterministic Supabase bucket → private S3 key mapping.
 * Source object path is preserved so database file_path values stay usable.
 *
 * s3://$FILES_BUCKET/files/{bucket}/{original_path}
 *
 * Never place application objects under Migration/ or database-export prefixes.
 */

export const FILES_PREFIX = 'files/';

export const APP_BUCKETS = Object.freeze([
  'claim-files',
  'claim-files-backup',
  'company-branding',
  'contractor-documents',
  'deposit-attachments',
  'document-templates',
  'email-assets',
  'endorsement-packets',
  'homeowner-uploads',
  'loss-draft-documents',
  'tenant-documents',
  'tenant-logos',
]);

export const SKIP_BUCKETS = Object.freeze([
  'ai-knowledge-base',
  'database_export_01_09_26',
  'database-export',
  'database_export',
]);

export const PUBLIC_BRANDING_BUCKETS = Object.freeze([
  'tenant-logos',
  'email-assets',
]);

export const APP_BUCKET_SET = new Set(APP_BUCKETS);
export const SKIP_BUCKET_SET = new Set(SKIP_BUCKETS);

export const toStorageObjectPath = (value, bucket = 'claim-files') => {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) {
    return v.replace(new RegExp(`^${bucket}/`), '').replace(/^\/+/, '');
  }
  try {
    const url = new URL(v);
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:sign\/|public\/)?([^/]+)\/(.+)$/);
    if (match && match[1] === bucket) {
      return decodeURIComponent(match[2]);
    }
    return null;
  } catch {
    return null;
  }
};

export const normalizePath = (value, bucket) => {
  const rel = toStorageObjectPath(value, bucket) || String(value || '').trim();
  if (!rel) return null;
  if (rel.includes('\0')) return null;
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (parts[0] === 'Migration') return null;
  return parts.join('/');
};

export const pathCandidates = (bucket, input) => {
  const rel = normalizePath(input, bucket);
  const out = new Set();
  for (const v of [input, rel, rel ? `${bucket}/${rel}` : null]) {
    if (!v) continue;
    const s = String(v).trim();
    if (!s) continue;
    out.add(s);
    out.add(s.split('?')[0]);
  }
  if (rel) out.add(rel);
  return [...out];
};

export const s3KeyFor = (bucket, objectPath) => {
  if (!APP_BUCKET_SET.has(bucket) || SKIP_BUCKET_SET.has(bucket)) return null;
  const rel = normalizePath(objectPath, bucket);
  if (!rel) return null;
  return `${FILES_PREFIX}${bucket}/${rel}`;
};

export const parsePublicQuery = (event) => {
  const query = event?.queryStringParameters || {};
  const body = (() => {
    if (!event?.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
  })();
  const bucket = String(query.bucket || body.bucket || '').trim();
  const path = String(query.path || body.path || '').trim();
  return { bucket, path };
};
