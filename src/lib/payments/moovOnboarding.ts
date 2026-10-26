/**
 * Compliance & Docs onboarding: contract types, the API wrapper and the pure
 * rules the UI depends on.
 *
 * This module deliberately has no React and no client imports so it can be
 * unit tested in isolation. The caller supplies an `invoke(name, body)` that
 * maps onto `supabase.functions.invoke` (POST /functions/v1/<name> on AWS).
 *
 * Sensitive values:
 *  - The full SSN and EIN are write-only. They are typed into the form, sent
 *    once in `moov-onboarding-save`, and never kept anywhere afterwards. The
 *    server only ever returns `ssn_last4` / `ein_masked`.
 *  - `redactSensitive` scrubs SSN/EIN-shaped digit runs from any text that
 *    could reach a toast or the console.
 */

import {
  CONTENT_TYPE_BY_EXTENSION,
  MAX_UPLOAD_BYTES,
  fileExtension,
  isVerificationPurpose,
  type VerificationPurpose,
} from "./verificationFiles.ts";

/* ------------------------------------------------------------------ */
/* Contract types                                                      */
/* ------------------------------------------------------------------ */

export interface OnboardingAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface OnboardingAccount {
  connected: boolean;
  status: string | null;
  capabilities: Record<string, unknown> | string[] | null;
  tos_accepted: boolean;
}

export interface OnboardingBusiness {
  legal_name: string | null;
  dba: string | null;
  type: string | null;
  ein_masked: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  address: OnboardingAddress | null;
  /** The payment provider's industry identifier (from listIndustries). */
  industry: string | null;
}

/** One entry of the payment provider's industry list. */
export interface OnboardingIndustry {
  industry: string;
  displayName: string;
  category: string | null;
  categoryDisplayName: string | null;
}

export interface OnboardingRepresentative {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  dob_masked: string | null;
  ssn_last4: string | null;
  address: OnboardingAddress | null;
  is_controller: boolean;
  ownership_pct: number | string | null;
  ssn_resubmit_required?: boolean;
}

export interface OnboardingDocument {
  id: string;
  purpose: string;
  file_name: string;
  size: number | null;
  content_type: string | null;
  uploaded_at: string | null;
  moov_file_id: string | null;
  moov_status: string | null;
}

export interface OnboardingBank {
  id: string;
  last4: string | null;
  routing_masked: string | null;
  status: string | null;
  verification: string | null;
}

export interface OnboardingSync {
  pending: boolean;
  last_error_code: string | null;
}

export interface OnboardingState {
  ok: boolean;
  environment: string | null;
  account: OnboardingAccount;
  business: OnboardingBusiness;
  representatives: OnboardingRepresentative[];
  documents: OnboardingDocument[];
  banks: OnboardingBank[];
  sync: OnboardingSync;
  can_submit: boolean;
}

export interface SaveResult extends Partial<OnboardingState> {
  ok: boolean;
  saved: boolean;
  moov_synced: boolean;
  pending: boolean;
  error_code: string | null;
  /** Field paths Moov refused (e.g. "profile.business.website"); only on moov_rejected. */
  rejected_fields?: string[];
}

export interface UploadUrlResult {
  document_id: string;
  upload_url: string;
  headers: Record<string, string>;
}

/** Business fields as sent to `moov-onboarding-save`. `ein` only when changed. */
export interface BusinessPayload {
  legal_name: string;
  dba: string;
  type: string;
  email: string;
  phone: string;
  website: string;
  description: string;
  address: OnboardingAddress;
  /** null clears the industry on file. */
  industry: string | null;
  ein?: string;
}

/** Representative fields as sent. `ssn`/`dob` only when (re-)entered. */
export interface RepresentativePayload {
  id?: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  address: OnboardingAddress;
  is_controller: boolean;
  ownership_pct: number | null;
  ssn?: string;
  dob?: string;
}

export interface SavePayload {
  tenant_id: string;
  business: BusinessPayload;
  representatives: RepresentativePayload[];
}

export type InvokeFn = (name: string, body: Record<string, unknown>) => Promise<unknown>;

type RawState = Partial<Omit<OnboardingState, "account" | "sync" | "can_submit" | "environment">> & {
  account?: Partial<OnboardingAccount>;
  sync?: Partial<OnboardingSync>;
  can_submit?: unknown;
  environment?: unknown;
};

/* ------------------------------------------------------------------ */
/* Normalisation of the get/save response                              */
/* ------------------------------------------------------------------ */

const EMPTY_BUSINESS: OnboardingBusiness = {
  legal_name: null,
  dba: null,
  type: null,
  ein_masked: null,
  email: null,
  phone: null,
  website: null,
  description: null,
  address: null,
  industry: null,
};

/** Fills defaults so the UI never crashes on a partial server response. */
export function normalizeOnboardingState(raw: unknown): OnboardingState {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawState;
  return {
    ok: r.ok !== false,
    environment: typeof r.environment === "string" ? r.environment : null,
    account: {
      connected: !!r.account?.connected,
      status: r.account?.status ?? null,
      capabilities: r.account?.capabilities ?? null,
      tos_accepted: !!r.account?.tos_accepted,
    },
    business: { ...EMPTY_BUSINESS, ...(r.business ?? {}) },
    representatives: Array.isArray(r.representatives) ? r.representatives : [],
    documents: Array.isArray(r.documents) ? r.documents : [],
    banks: Array.isArray(r.banks) ? r.banks : [],
    sync: {
      pending: !!r.sync?.pending,
      last_error_code: r.sync?.last_error_code ?? null,
    },
    // Fail closed: only an explicit `true` from the server enables editing.
    can_submit: r.can_submit === true,
  };
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

// SSN (123-45-6789 / 123 45 6789 / 123456789) and EIN (12-3456789) shapes,
// plus any bare run of 9+ digits.
const SENSITIVE_PATTERNS = [
  /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  /\b\d{2}[-\s]?\d{7}\b/g,
  /\d{9,}/g,
];

export function redactSensitive(text: unknown): string {
  let s = typeof text === "string" ? text : text == null ? "" : String(text);
  for (const p of SENSITIVE_PATTERNS) s = s.replace(p, "[redacted]");
  return s;
}

/** Safe, user-facing error message from anything thrown. */
export function safeErrorMessage(e: unknown, fallback = "Something went wrong."): string {
  const raw = (e as { message?: unknown } | null)?.message ?? (typeof e === "string" ? e : "");
  const msg = redactSensitive(raw).trim();
  return msg || fallback;
}

/** Server codes meaning onboarding is switched off on this deployment (not a failure). */
export const ONBOARDING_UNAVAILABLE_CODES = Object.freeze(["production_execution_blocked", "provider_disabled"]);
export const isOnboardingUnavailableCode = (code: string | null | undefined): boolean =>
  !!code && (ONBOARDING_UNAVAILABLE_CODES as readonly string[]).includes(code);

export class OnboardingApiError extends Error {
  code: string | null;
  status: number | null;
  constructor(message: string, code: string | null = null, status: number | null = null) {
    super(redactSensitive(message));
    this.name = "OnboardingApiError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* API wrapper                                                         */
/* ------------------------------------------------------------------ */

export function createOnboardingApi(invoke: InvokeFn) {
  const call = async <T>(name: string, body: object): Promise<Partial<T>> =>
    ((await invoke(name, body as Record<string, unknown>)) ?? {}) as Partial<T>;
  return {
    get: async (tenantId: string): Promise<OnboardingState> =>
      normalizeOnboardingState(await invoke("moov-onboarding-get", { tenant_id: tenantId })),

    save: async (payload: SavePayload): Promise<SaveResult> => {
      const res = await call<SaveResult>("moov-onboarding-save", payload);
      return {
        ...res,
        ok: res?.ok !== false,
        saved: !!res?.saved,
        moov_synced: !!res?.moov_synced,
        pending: !!res?.pending,
        error_code: res?.error_code ?? null,
        rejected_fields: Array.isArray(res?.rejected_fields)
          ? res.rejected_fields.filter((f): f is string => typeof f === "string")
          : undefined,
      };
    },

    listIndustries: async (tenantId: string): Promise<OnboardingIndustry[]> => {
      const res = await call<{ industries: OnboardingIndustry[] }>("moov-onboarding-get", {
        tenant_id: tenantId,
        action: "industries",
      });
      return Array.isArray(res?.industries)
        ? res.industries.filter((i): i is OnboardingIndustry => typeof i?.industry === "string" && i.industry !== "")
        : [];
    },

    revealEin: async (tenantId: string): Promise<string> => {
      const res = await call<{ ein: string }>("moov-ein-reveal", { tenant_id: tenantId });
      return typeof res?.ein === "string" ? res.ein : "";
    },

    requestUploadUrl: async (args: {
      tenantId: string;
      purpose: VerificationPurpose;
      fileName: string;
      contentType: string;
      size: number;
    }): Promise<UploadUrlResult> => {
      const res = await call<UploadUrlResult>("moov-document-upload-url", {
        tenant_id: args.tenantId,
        purpose: args.purpose,
        file_name: args.fileName,
        content_type: args.contentType,
        size: args.size,
      });
      if (!res?.document_id || !res?.upload_url) {
        throw new OnboardingApiError("The upload could not be started.", "upload_url_missing");
      }
      return { document_id: res.document_id, upload_url: res.upload_url, headers: res.headers ?? {} };
    },

    finalizeDocument: async (tenantId: string, documentId: string): Promise<OnboardingDocument> =>
      (await call<OnboardingDocument>("moov-document-finalize", { tenant_id: tenantId, document_id: documentId })) as OnboardingDocument,

    viewDocument: async (tenantId: string, documentId: string): Promise<string> => {
      const res = await call<{ url: string }>("moov-document-view", { tenant_id: tenantId, document_id: documentId });
      if (!res?.url) throw new OnboardingApiError("The document link is unavailable.", "view_url_missing");
      return res.url;
    },

    acceptTerms: async (tenantId: string) =>
      invoke("moov-tos-accept", { tenant_id: tenantId, accepted: true }),

    sync: async (tenantId: string) => invoke("moov-sync", { tenant_id: tenantId }),
  };
}

export type OnboardingApi = ReturnType<typeof createOnboardingApi>;

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export type FileValidation =
  | { ok: true; contentType: string }
  | { ok: false; error: string };

export function validateDocumentFile(file: { name: string; size: number }): FileValidation {
  const ext = fileExtension(file.name);
  const contentType = CONTENT_TYPE_BY_EXTENSION[ext];
  if (!contentType) {
    return { ok: false, error: "Only PDF, JPG, PNG or CSV files can be uploaded." };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "Documents must be 20 MB or smaller." };
  }
  return { ok: true, contentType };
}

export type UploadStage = "validate" | "upload_url" | "put" | "finalize";

export class DocumentUploadError extends Error {
  stage: UploadStage;
  documentId: string | null;
  constructor(stage: UploadStage, message: string, documentId: string | null = null) {
    super(redactSensitive(message));
    this.name = "DocumentUploadError";
    this.stage = stage;
    this.documentId = documentId;
  }
}

export type PutFn = (
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress?: (percent: number) => void,
) => Promise<void>;

/**
 * upload-url -> PUT (presigned, exact headers) -> finalize.
 * A finalize failure carries the document id so the caller can retry only
 * the finalize step (it is idempotent server side).
 */
export async function uploadOnboardingDocument(args: {
  api: Pick<OnboardingApi, "requestUploadUrl" | "finalizeDocument">;
  put: PutFn;
  tenantId: string;
  purpose: string;
  file: Blob & { name: string; size: number };
  onProgress?: (percent: number) => void;
}): Promise<OnboardingDocument> {
  if (!isVerificationPurpose(args.purpose)) {
    throw new DocumentUploadError("validate", "Choose a document type.");
  }
  const check = validateDocumentFile(args.file);
  if (check.ok === false) throw new DocumentUploadError("validate", check.error);

  let target: UploadUrlResult;
  try {
    target = await args.api.requestUploadUrl({
      tenantId: args.tenantId,
      purpose: args.purpose,
      fileName: args.file.name,
      contentType: check.contentType,
      size: args.file.size,
    });
  } catch (e) {
    throw new DocumentUploadError("upload_url", safeErrorMessage(e, "The upload could not be started."));
  }

  try {
    args.onProgress?.(0);
    await args.put(target.upload_url, target.headers, args.file, args.onProgress);
    args.onProgress?.(100);
  } catch (e) {
    throw new DocumentUploadError("put", safeErrorMessage(e, "The file could not be uploaded."), target.document_id);
  }

  try {
    return await args.api.finalizeDocument(args.tenantId, target.document_id);
  } catch (e) {
    throw new DocumentUploadError(
      "finalize",
      safeErrorMessage(e, "Uploaded, but submitting it failed. Retry to finish."),
      target.document_id,
    );
  }
}

/** Browser PUT with upload progress. Sends exactly the presigned headers. */
export const xhrPut: PutFn = (url, headers, body, onProgress) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status}).`));
    };
    xhr.send(body);
  });

export type DocumentMoovTone = "ok" | "pending" | "error" | "none";

export function describeDocumentStatus(doc: Pick<OnboardingDocument, "moov_file_id" | "moov_status">): {
  label: string;
  tone: DocumentMoovTone;
  retryable: boolean;
} {
  const s = (doc.moov_status ?? "").toLowerCase();
  if (["approved", "accepted", "verified"].includes(s)) return { label: "Approved", tone: "ok", retryable: false };
  if (["rejected", "denied"].includes(s)) return { label: "Rejected", tone: "error", retryable: false };
  if (["failed", "error", "sync_failed", "finalize_failed"].includes(s)) {
    return { label: "Not submitted", tone: "error", retryable: true };
  }
  if (!doc.moov_file_id) return { label: "Stored, not yet submitted", tone: "pending", retryable: true };
  return { label: "Submitted, in review", tone: "pending", retryable: false };
}

/* ------------------------------------------------------------------ */
/* Form <-> payload                                                    */
/* ------------------------------------------------------------------ */

export interface BusinessForm {
  legal_name: string;
  dba: string;
  type: string;
  email: string;
  phone: string;
  website: string;
  description: string;
  industry: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  /** Write-only. Empty means "unchanged". */
  ein: string;
}

export interface RepresentativeForm {
  /** Local key for React lists. */
  key: string;
  id?: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  is_controller: boolean;
  ownership_pct: string;
  /** Write-only. Empty means "unchanged". Never prefilled. */
  ssn: string;
  /** Empty means "unchanged". Never prefilled. */
  dob: string;
  /** From the server: masked values for display only. */
  ssn_last4: string | null;
  dob_masked: string | null;
  ssn_resubmit_required: boolean;
}

export function businessFormFrom(b: OnboardingBusiness | null | undefined): BusinessForm {
  const a = b?.address ?? {};
  return {
    legal_name: b?.legal_name ?? "",
    dba: b?.dba ?? "",
    type: b?.type ?? "",
    email: b?.email ?? "",
    phone: b?.phone ?? "",
    website: b?.website ?? "",
    description: b?.description ?? "",
    industry: b?.industry ?? "",
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    postal_code: a.postal_code ?? "",
    ein: "",
  };
}

let repKeySeq = 0;
export function newRepresentativeKey(): string {
  repKeySeq += 1;
  return `rep-new-${repKeySeq}`;
}

export function representativeFormFrom(r: OnboardingRepresentative): RepresentativeForm {
  const a = r.address ?? {};
  return {
    key: `rep-${r.id}`,
    id: r.id,
    name: r.name ?? "",
    email: r.email ?? "",
    phone: r.phone ?? "",
    title: r.title ?? "",
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    postal_code: a.postal_code ?? "",
    is_controller: !!r.is_controller,
    ownership_pct: r.ownership_pct == null ? "" : String(r.ownership_pct),
    ssn: "",
    dob: "",
    ssn_last4: r.ssn_last4 ?? null,
    dob_masked: r.dob_masked ?? null,
    ssn_resubmit_required: !!r.ssn_resubmit_required,
  };
}

export function emptyRepresentativeForm(isController = false): RepresentativeForm {
  return {
    key: newRepresentativeKey(),
    name: "",
    email: "",
    phone: "",
    title: isController ? "Owner" : "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal_code: "",
    is_controller: isController,
    ownership_pct: "",
    ssn: "",
    dob: "",
    ssn_last4: null,
    dob_masked: null,
    ssn_resubmit_required: false,
  };
}

export const digitsOnly = (v: string, max?: number) => {
  const d = (v ?? "").replace(/\D/g, "");
  return max ? d.slice(0, max) : d;
};

/** Returns a list of human-readable problems; empty means OK to submit. */
export function validateOnboardingForm(b: BusinessForm, reps: RepresentativeForm[]): string[] {
  const errs: string[] = [];
  if (!b.legal_name.trim()) errs.push("Legal business name is required.");
  if (b.ein && digitsOnly(b.ein).length !== 9) errs.push("EIN must be 9 digits.");
  if (!b.line1.trim() || !b.city.trim() || !b.state.trim() || !b.postal_code.trim()) {
    errs.push("Business address is incomplete.");
  }
  if (reps.length === 0) errs.push("Add at least one representative.");
  if (reps.length > 0 && !reps.some((r) => r.is_controller)) errs.push("Mark one representative as the controller.");
  reps.forEach((r, i) => {
    const who = r.name.trim() || `Representative ${i + 1}`;
    if (!r.name.trim()) errs.push(`Representative ${i + 1}: name is required.`);
    const ssn = digitsOnly(r.ssn);
    if (ssn && ssn.length !== 9) errs.push(`${who}: SSN must be 9 digits.`);
    if (!r.id && !ssn) errs.push(`${who}: SSN is required.`);
    if (r.ssn_resubmit_required && !ssn) errs.push(`${who}: please re-enter the SSN.`);
    if (!r.id && !r.dob) errs.push(`${who}: date of birth is required.`);
    if (r.ownership_pct && !(Number(r.ownership_pct) >= 0 && Number(r.ownership_pct) <= 100)) {
      errs.push(`${who}: ownership must be between 0 and 100.`);
    }
  });
  return errs;
}

/**
 * Builds the save request. `ein`, `ssn` and `dob` are included only when the
 * user typed a new value; unchanged write-only fields are omitted.
 */
export function buildSavePayload(tenantId: string, b: BusinessForm, reps: RepresentativeForm[]): SavePayload {
  const business: BusinessPayload = {
    legal_name: b.legal_name.trim(),
    dba: b.dba.trim(),
    type: b.type,
    email: b.email.trim(),
    phone: b.phone.trim(),
    website: b.website.trim(),
    description: b.description.trim(),
    industry: b.industry || null,
    address: {
      line1: b.line1.trim(),
      line2: b.line2.trim(),
      city: b.city.trim(),
      state: b.state.trim(),
      postal_code: b.postal_code.trim(),
    },
  };
  const ein = digitsOnly(b.ein);
  if (ein) business.ein = ein;

  const representatives = reps.map((r) => {
    const p: RepresentativePayload = {
      name: r.name.trim(),
      email: r.email.trim(),
      phone: r.phone.trim(),
      title: r.title.trim(),
      address: {
        line1: r.line1.trim(),
        line2: r.line2.trim(),
        city: r.city.trim(),
        state: r.state.trim(),
        postal_code: r.postal_code.trim(),
      },
      is_controller: r.is_controller,
      ownership_pct: r.ownership_pct === "" ? null : Number(r.ownership_pct),
    };
    if (r.id) p.id = r.id;
    const ssn = digitsOnly(r.ssn);
    if (ssn) p.ssn = ssn;
    if (r.dob) p.dob = r.dob;
    return p;
  });

  return { tenant_id: tenantId, business, representatives };
}

/** Strips every write-only secret from form state (called as soon as a save is sent). */
export function clearSecrets(b: BusinessForm, reps: RepresentativeForm[]): {
  business: BusinessForm;
  representatives: RepresentativeForm[];
} {
  return {
    business: { ...b, ein: "" },
    representatives: reps.map((r) => ({ ...r, ssn: "", dob: "" })),
  };
}

/* ------------------------------------------------------------------ */
/* Display helpers                                                     */
/* ------------------------------------------------------------------ */

export function maskedSsn(last4: string | null | undefined): string {
  const l = digitsOnly(last4 ?? "").slice(-4);
  return l ? `•••-••-${l}` : "Not on file";
}

export function maskedEin(einMasked: string | null | undefined): string {
  if (!einMasked) return "Not on file";
  // Never trust the server shape blindly: only ever render the last 4 digits.
  const l = digitsOnly(einMasked).slice(-4);
  return l ? `••-•••${l}` : "On file";
}

export type SyncTone = "idle" | "working" | "ok" | "warn" | "error";

/**
 * Honest sync status:
 *  - "Saving…" while the request is in flight
 *  - "Saved, sending to Moov…" while the server reports pending
 *  - "Saved, Moov retry pending (code)" when the Moov call failed but the data is saved
 *  - "Synced" only when Moov confirmed
 */
/** Plain-language names for the Moov field paths the API reports in rejected_fields. */
const MOOV_FIELD_LABELS: Array<[RegExp, string]> = [
  [/^profile\.business\.website$/, "Website"],
  [/^profile\.business\.legalBusinessName$/, "Legal business name"],
  [/^profile\.business\.doingBusinessAs$/, "DBA"],
  [/^profile\.business\.businessType$/, "Business type"],
  [/^profile\.business\.email$/, "Business email"],
  [/^profile\.business\.phone(\..*)?$/, "Business phone"],
  [/^profile\.business\.address(\..*)?$/, "Business address"],
  [/^profile\.business\.description$/, "Description"],
  [/^profile\.business\.industry(Codes)?(\..*)?$/, "Industry"],
  [/^profile\.business\.taxID(\..*)?$/, "EIN"],
  [/^(representatives\.\d+\.)?name(\..*)?$/, "Representative name"],
  [/^(representatives\.\d+\.)?email$/, "Representative email"],
  [/^(representatives\.\d+\.)?phone(\..*)?$/, "Representative phone"],
  [/^(representatives\.\d+\.)?address(\..*)?$/, "Representative home address"],
  [/^(representatives\.\d+\.)?birthDate(\..*)?$/, "Representative date of birth"],
  [/^(representatives\.\d+\.)?governmentID(\..*)?$/, "Representative SSN"],
  [/^(representatives\.\d+\.)?responsibilities(\..*)?$/, "Representative role or ownership"],
];

/** "Website" for "profile.business.website"; the raw path when unknown. */
export function moovFieldLabel(path: string): string {
  for (const [re, label] of MOOV_FIELD_LABELS) if (re.test(path)) return label;
  return path;
}

/** An error code as shown to users: the provider prefix is dropped (moov_rejected -> rejected). */
const shownCode = (code: string) => String(code).replace(/^moov_/, "");

/** One sentence naming what Moov refused, or null when nothing was reported. */
export function describeRejectedFields(fields: string[] | null | undefined): string | null {
  const labels = Array.from(new Set((fields ?? []).map(moovFieldLabel)));
  if (labels.length === 0) return null;
  return `Not accepted: ${labels.join(", ")}. Correct ${labels.length === 1 ? "it" : "them"} and save again.`;
}

export function describeSyncStatus(args: {
  saving: boolean;
  lastSave?: Pick<SaveResult, "saved" | "moov_synced" | "pending" | "error_code" | "rejected_fields"> | null;
  sync?: OnboardingSync | null;
  accountConnected?: boolean;
}): { tone: SyncTone; label: string } {
  if (args.saving) return { tone: "working", label: "Saving…" };
  const s = args.lastSave;
  if (s) {
    if (!s.saved) return { tone: "error", label: `Not saved${s.error_code ? ` (${shownCode(s.error_code)})` : ""}` };
    if (s.moov_synced && !s.pending) return { tone: "ok", label: "Synced" };
    if (s.error_code === "moov_rejected" && s.rejected_fields?.length) {
      return { tone: "error", label: `Saved. ${describeRejectedFields(s.rejected_fields)}` };
    }
    if (s.error_code) return { tone: "warn", label: `Saved, submission retry pending (${shownCode(s.error_code)})` };
    return { tone: "working", label: "Saved, submitting…" };
  }
  const sync = args.sync;
  if (sync?.last_error_code) return { tone: "warn", label: `Saved, submission retry pending (${shownCode(sync.last_error_code)})` };
  if (sync?.pending) return { tone: "working", label: "Saved, submitting…" };
  if (args.accountConnected) return { tone: "ok", label: "Synced" };
  return { tone: "idle", label: "Not yet submitted" };
}

/**
 * Who may edit. The server's `can_submit` decides; in Tenant Management the
 * platform owner additionally has to opt in with "Edit on behalf of tenant".
 */
export function resolveComplianceAccess(args: {
  canSubmit: boolean | null | undefined;
  adminView?: boolean;
  editOnBehalf?: boolean;
}): { readOnly: boolean; canRevealEin: boolean; canAcceptTerms: boolean; showEditOnBehalfToggle: boolean } {
  const canSubmit = args.canSubmit === true;
  const readOnly = !canSubmit || (!!args.adminView && !args.editOnBehalf);
  return {
    readOnly,
    // EIN reveal and the Moov terms are the tenant members' own (the server
    // refuses the platform owner unless it is a member): never offered in the
    // Tenant Management view, even when editing on the tenant's behalf.
    canRevealEin: canSubmit && !args.adminView,
    canAcceptTerms: !readOnly && !args.adminView,
    showEditOnBehalfToggle: !!args.adminView && canSubmit,
  };
}

/** How long a revealed EIN stays visible before it is re-masked. */
export const EIN_REVEAL_MS = 30_000;
