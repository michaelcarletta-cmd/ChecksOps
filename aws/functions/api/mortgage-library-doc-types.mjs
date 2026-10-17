/**
 * Canonical Mortgage Ops library document types and the full tenant_documents
 * doc_type write allowlist.
 *
 * Must stay in sync with `src/lib/mortgageLibraryDocTypes.ts` and
 * `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql`.
 *
 * SQL 29 keeps a broader `library:mortgage:%` prefix check as defense in depth.
 * Application writes and the SQL 30 CHECK constraint use this exact set.
 */

export const MORTGAGE_LIBRARY_DOC_PREFIX = 'library:mortgage:';

export const MORTGAGE_LIBRARY_DOC_KINDS = Object.freeze([
  { label: 'W-9', docType: 'library:mortgage:w-9' },
  { label: 'Contractor license', docType: 'library:mortgage:contractor-license' },
  { label: 'General liability insurance', docType: 'library:mortgage:general-liability-insurance' },
  { label: 'Workers comp insurance', docType: 'library:mortgage:workers-comp-insurance' },
  { label: 'Certificate of insurance', docType: 'library:mortgage:certificate-of-insurance' },
  { label: 'Signed contract', docType: 'library:mortgage:signed-contract' },
  { label: 'Adjuster / TPA letter', docType: 'library:mortgage:adjuster-tpa-letter' },
]);

export const MORTGAGE_LIBRARY_DOC_TYPES = Object.freeze(
  MORTGAGE_LIBRARY_DOC_KINDS.map((kind) => kind.docType),
);

/** Predecessor tenant_documents.doc_type values preserved by SQL 30. */
export const LEGACY_TENANT_DOCUMENT_DOC_TYPES = Object.freeze([
  'w9',
  'license',
  'insurance',
  'saas_agreement',
  'terms_of_service',
  'privacy_policy',
]);

export const TENANT_DOCUMENT_DOC_TYPES = Object.freeze([
  ...LEGACY_TENANT_DOCUMENT_DOC_TYPES,
  ...MORTGAGE_LIBRARY_DOC_TYPES,
]);

export const isApprovedMortgageLibraryDocType = (docType) =>
  MORTGAGE_LIBRARY_DOC_TYPES.includes(String(docType || ''));

/**
 * Non-mortgage Document Library categories (SQL 94,
 * aws/workflows/sql/94_document_library_restore.sql, which mirrors this in
 * public.aws_tenant_document_doc_type_ok). Stored as `library:<category>:<slug>`;
 * the slug is lowercase letters and digits in words joined by single hyphens,
 * at most 60 characters.
 */
export const LIBRARY_FREE_SLUG_CATEGORIES = Object.freeze(['template', 'shingle', 'siding', 'catalog', 'letterhead']);
export const LIBRARY_CATEGORIES = Object.freeze(['mortgage', ...LIBRARY_FREE_SLUG_CATEGORIES]);
export const LIBRARY_SLUG_MAX = 60;
export const LIBRARY_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LIBRARY_FREE_DOC_TYPE_RE = /^library:(template|shingle|siding|catalog|letterhead):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const isLibraryFreeSlugDocType = (docType) => {
  const match = String(docType ?? '').match(LIBRARY_FREE_DOC_TYPE_RE);
  return Boolean(match && match[2].length <= LIBRARY_SLUG_MAX);
};

/** The library category of an allowed library doc_type, else null. */
export const libraryCategoryOf = (docType) => {
  const text = String(docType ?? '');
  if (isApprovedMortgageLibraryDocType(text)) return 'mortgage';
  return isLibraryFreeSlugDocType(text) ? text.split(':')[1] : null;
};

export const isAllowedTenantDocumentDocType = (docType) =>
  TENANT_DOCUMENT_DOC_TYPES.includes(String(docType || ''))
  || isLibraryFreeSlugDocType(docType);
