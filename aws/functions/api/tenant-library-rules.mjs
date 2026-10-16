/**
 * Document Library (Compliance & Docs) object rules shared by the storage
 * upload signer, the generic tenant_documents writer and the library handlers.
 *
 * Objects live in the tenant-documents bucket at
 *   {tenantId}/library/{category}/{file}
 * (s3://$FILES_BUCKET/files/tenant-documents/...). The category folder must be
 * the doc_type's category, so a stored path names what it is.
 */
import { MAX_UPLOAD_BYTES, matchTenantDocumentPath, normalizePath } from './storage-paths.mjs';
import { LIBRARY_CATEGORIES, libraryCategoryOf } from './mortgage-library-doc-types.mjs';

export const LIBRARY_BUCKET = 'tenant-documents';
export const LIBRARY_MAX_BYTES = MAX_UPLOAD_BYTES; // 25 MB

/** Library uploads: documents and images only (no SVG, HTML, text or octet-stream). */
export const LIBRARY_CONTENT_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);
const LIBRARY_CONTENT_TYPE_SET = new Set(LIBRARY_CONTENT_TYPES);

export const normalizeContentType = (value) => {
  const text = String(value ?? '').split(';')[0].trim().toLowerCase();
  return text === 'image/jpg' ? 'image/jpeg' : text;
};

export const isLibraryContentType = (value) => LIBRARY_CONTENT_TYPE_SET.has(normalizeContentType(value));

export const isLibrarySize = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= LIBRARY_MAX_BYTES;
};

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * The relative library path when it is exactly {tenantId}/library/{category}/{file}
 * for this tenant (and, when given, this category); otherwise null.
 */
export const libraryObjectPath = (value, { tenantId, category } = {}) => {
  const rel = normalizePath(value, LIBRARY_BUCKET);
  if (!rel || rel.length > 512) return null;
  if (matchTenantDocumentPath(rel) !== String(tenantId || '').toLowerCase()) return null;
  const parts = rel.split('/');
  if (parts.length !== 4 || parts[1] !== 'library') return null;
  if (!LIBRARY_CATEGORIES.includes(parts[2])) return null;
  if (category && parts[2] !== category) return null;
  if (!FILE_RE.test(parts[3])) return null;
  return rel;
};

/** The category folder a doc_type must be stored under (null for legacy, non-library types). */
export const libraryFolderFor = (docType) => libraryCategoryOf(docType);
