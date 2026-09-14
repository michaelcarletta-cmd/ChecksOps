/**
 * Canonical Mortgage Ops library document types.
 *
 * TenantDocumentLibrary stores mortgage packet files as
 * `tenant_documents.doc_type = library:mortgage:<slug>`.
 * These are the only mortgage slugs the UI may emit. Do not interpolate
 * display names or filenames into the suffix.
 *
 * Must stay in sync with `aws/functions/api/mortgage-library-doc-types.mjs`
 * and `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql`.
 */

export const MORTGAGE_LIBRARY_DOC_PREFIX = "library:mortgage:" as const;

export const MORTGAGE_LIBRARY_DOC_KINDS = [
  { label: "W-9", docType: "library:mortgage:w-9" },
  { label: "Contractor license", docType: "library:mortgage:contractor-license" },
  { label: "General liability insurance", docType: "library:mortgage:general-liability-insurance" },
  { label: "Workers comp insurance", docType: "library:mortgage:workers-comp-insurance" },
  { label: "Certificate of insurance", docType: "library:mortgage:certificate-of-insurance" },
  { label: "Signed contract", docType: "library:mortgage:signed-contract" },
  { label: "Adjuster / TPA letter", docType: "library:mortgage:adjuster-tpa-letter" },
] as const;

export type MortgageLibraryDocType = (typeof MORTGAGE_LIBRARY_DOC_KINDS)[number]["docType"];

export const MORTGAGE_LIBRARY_DOC_TYPES: readonly MortgageLibraryDocType[] =
  MORTGAGE_LIBRARY_DOC_KINDS.map((kind) => kind.docType);

export const isApprovedMortgageLibraryDocType = (docType: string | null | undefined): boolean =>
  (MORTGAGE_LIBRARY_DOC_TYPES as readonly string[]).includes(String(docType || ""));

export const mortgageLibraryDocTypeForLabel = (label: string | null | undefined): MortgageLibraryDocType | null => {
  const found = MORTGAGE_LIBRARY_DOC_KINDS.find((kind) => kind.label === label);
  return found?.docType ?? null;
};
