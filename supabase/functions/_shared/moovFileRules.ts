// Pure validation/normalization rules for tenant verification-document uploads
// (Moov KYB/KYC account Files API). No network, no database — unit testable.

/**
 * Document purposes ChecksOps supports during onboarding. The first four are
 * native Moov account file purposes; the rest are ChecksOps compliance
 * document types that are still streamed to Moov (mapped to the closest
 * supported provider purpose) so everything lives in one place.
 */
export const FILE_PURPOSES = [
  "business_verification",
  "identity_verification",
  "individual_verification",
  "representative_verification",
  "w9",
  "bank_statement",
  "license",
  "insurance",
  "saas_agreement",
  "terms_of_service",
  "privacy_policy",
] as const;

export type FilePurpose = (typeof FILE_PURPOSES)[number];

/** Native Moov account file purposes. */
export type MoovFilePurpose =
  | "business_verification"
  | "identity_verification"
  | "individual_verification"
  | "representative_verification";

const MOOV_PURPOSE_MAP: Record<string, MoovFilePurpose> = {
  w9: "business_verification",
  bank_statement: "business_verification",
  license: "business_verification",
  insurance: "business_verification",
  saas_agreement: "business_verification",
  terms_of_service: "business_verification",
  privacy_policy: "business_verification",
};

/** Maps a ChecksOps document type to the provider purpose Moov accepts. */
export function moovPurposeFor(purpose: FilePurpose): MoovFilePurpose {
  return MOOV_PURPOSE_MAP[purpose] ?? (purpose as MoovFilePurpose);
}

/** Purposes that must be tied to a specific business representative. */
export const REPRESENTATIVE_PURPOSES: FilePurpose[] = ["representative_verification"];

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "text/csv": ["csv"],
  "application/csv": ["csv"],
};

export const ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "csv"];

export function isFilePurpose(v: unknown): v is FilePurpose {
  return typeof v === "string" && (FILE_PURPOSES as readonly string[]).includes(v);
}

export function requiresRepresentative(purpose: FilePurpose): boolean {
  return REPRESENTATIVE_PURPOSES.includes(purpose);
}

export function fileExtension(name: string): string {
  const parts = String(name ?? "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop()! : "";
}

/** Filenames are echoed back to the UI — keep them boring and short. */
export function sanitizeFileName(name: string): string {
  const base = String(name ?? "document").split(/[\\/]/).pop() ?? "document";
  const cleaned = base.replace(/[^a-zA-Z0-9.\-_ ]/g, "_").trim();
  return (cleaned || "document").slice(0, 120);
}

export interface FileValidationInput {
  purpose: unknown;
  fileName: unknown;
  mimeType: unknown;
  sizeBytes: unknown;
  representativeId?: unknown;
}

export interface FileValidationResult {
  ok: boolean;
  error?: string;
  code?:
    | "invalid_purpose"
    | "missing_file"
    | "invalid_type"
    | "file_too_large"
    | "empty_file"
    | "representative_required";
  value?: {
    purpose: FilePurpose;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    representativeId: string | null;
  };
}

export function validateUpload(input: FileValidationInput): FileValidationResult {
  if (!isFilePurpose(input.purpose)) {
    return { ok: false, code: "invalid_purpose", error: "Unsupported document purpose." };
  }
  const purpose = input.purpose;

  if (typeof input.fileName !== "string" || input.fileName.trim() === "") {
    return { ok: false, code: "missing_file", error: "A document file is required." };
  }
  const fileName = sanitizeFileName(input.fileName);

  const size = Number(input.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, code: "empty_file", error: "The document file is empty." };
  }
  if (size > MAX_FILE_BYTES) {
    return { ok: false, code: "file_too_large", error: "Documents must be 20 MB or smaller." };
  }

  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().split(";")[0].trim() : "";
  const ext = fileExtension(fileName);
  const mimeOk = !!ALLOWED_MIME_TYPES[mimeType];
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  // Both signals must agree when the browser supplies a usable MIME type.
  if (!extOk || (mimeType && !mimeOk)) {
    return { ok: false, code: "invalid_type", error: "Only PDF, JPG, PNG, or CSV files are accepted." };
  }
  if (mimeOk && ext && !ALLOWED_MIME_TYPES[mimeType].includes(ext)) {
    return { ok: false, code: "invalid_type", error: "The file extension does not match its type." };
  }

  const representativeId =
    typeof input.representativeId === "string" && input.representativeId.trim() !== ""
      ? input.representativeId.trim()
      : null;

  if (requiresRepresentative(purpose) && !representativeId) {
    return {
      ok: false,
      code: "representative_required",
      error: "Select the business representative this document belongs to.",
    };
  }

  return {
    ok: true,
    value: {
      purpose,
      fileName,
      mimeType: mimeType || (ext === "pdf" ? "application/pdf" : "application/octet-stream"),
      sizeBytes: size,
      representativeId: requiresRepresentative(purpose) ? representativeId : representativeId,
    },
  };
}

/** Moov file decision → ChecksOps review status shown to tenants. */
export function normalizeReviewStatus(decision: string | null | undefined): string {
  switch ((decision ?? "").toLowerCase().replace(/[\s-]/g, "_")) {
    case "approved":
    case "accepted":
      return "approved";
    case "rejected":
    case "denied":
    case "failed":
      return "rejected";
    case "pending":
    case "pending_review":
    case "in_review":
    case "":
      return "pending";
    default:
      return "pending";
  }
}

/** Simple per-tenant abuse control: uploads allowed inside the rolling window. */
export const UPLOAD_RATE_LIMIT = { max: 20, windowMinutes: 60 };

export function rateLimitExceeded(recentCount: number): boolean {
  return recentCount >= UPLOAD_RATE_LIMIT.max;
}
