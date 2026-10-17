/**
 * Verification-document purposes and upload limits for the Compliance & Docs
 * onboarding flow.
 *
 * All provider authentication happens server side. Nothing in this file knows
 * or holds provider credentials. Uploads go browser -> presigned storage URL ->
 * server finalize (see moovOnboarding.ts); the browser never reads document
 * contents back except through a short-lived presigned view link.
 */

export const FILE_PURPOSE_OPTIONS = [
  { value: "business_verification", label: "Business verification" },
  { value: "identity_verification", label: "Identity verification" },
  { value: "individual_verification", label: "Individual verification" },
  { value: "representative_verification", label: "Representative verification" },
  { value: "w9", label: "W-9" },
  { value: "bank_statement", label: "Bank statement (last 3 months)" },
  { value: "license", label: "License" },
  { value: "insurance", label: "Insurance" },
  { value: "saas_agreement", label: "SaaS Agreement" },
  { value: "terms_of_service", label: "Terms of Service" },
  { value: "privacy_policy", label: "Privacy Policy" },
] as const;

export type VerificationPurpose = (typeof FILE_PURPOSE_OPTIONS)[number]["value"];

export const PURPOSE_LABEL: Record<string, string> = Object.fromEntries(
  FILE_PURPOSE_OPTIONS.map((o) => [o.value, o.label]),
);

/** Vetting documents every tenant is expected to have on file. */
export const VETTING_PURPOSES: VerificationPurpose[] = [
  "w9",
  "bank_statement",
  "license",
  "insurance",
  "saas_agreement",
  "terms_of_service",
  "privacy_policy",
];

export const ACCEPTED_EXTENSIONS = ".pdf,.jpg,.jpeg,.png,.csv";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Canonical content type per accepted extension. */
export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  csv: "text/csv",
};

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function isVerificationPurpose(v: string): v is VerificationPurpose {
  return FILE_PURPOSE_OPTIONS.some((o) => o.value === v);
}
