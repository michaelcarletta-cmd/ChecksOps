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

export const isAllowedTenantDocumentDocType = (docType) =>
  TENANT_DOCUMENT_DOC_TYPES.includes(String(docType || ''));
