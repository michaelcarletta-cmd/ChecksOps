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

/** Non-mortgage Document Library categories (SQL 94: library:<category>:<slug>). */
export const LIBRARY_FREE_SLUG_CATEGORIES = ["template", "shingle", "siding", "catalog", "letterhead"] as const;
export type LibraryFreeSlugCategory = (typeof LIBRARY_FREE_SLUG_CATEGORIES)[number];
export const LIBRARY_SLUG_MAX = 60;

/**
 * Slug for a library display name: lowercase letters and digits in words
 * joined by single hyphens, at most 60 characters, never a leading or trailing
 * hyphen. Same rule as the server (mortgage-library-doc-types.mjs) and SQL 94.
 */
export const librarySlugFor = (label: string | null | undefined, fallback: string): string => {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, LIBRARY_SLUG_MAX)
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  return String(fallback || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, LIBRARY_SLUG_MAX) || "doc";
};
