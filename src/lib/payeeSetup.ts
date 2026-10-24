/**
 * Payee setup (SQL 113 payee API, aws/functions/api/providers/payees/handlers.mjs).
 *
 * Pure helpers shared by the public /pay-setup/:token page and the tenant
 * Settings / check screens: the step a payee resumes at,
 * the status a tenant sees, and user-facing messages for the server's error
 * codes. No network, no storage, no identity numbers: SSN, EIN, routing and
 * account numbers never pass through this module.
 *
 * User-facing text here never names the payment provider.
 */

export type PayeeRecipientType = "individual" | "business";

/** Mirrors BUSINESS_TYPES in aws/functions/api/providers/onboarding/store.mjs. */
export const PAYEE_BUSINESS_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "llc", label: "LLC" },
  { value: "soleProprietorship", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
  { value: "privateCorporation", label: "Private corporation" },
  { value: "publicCorporation", label: "Public corporation" },
  { value: "trust", label: "Trust" },
  { value: "unincorporatedAssociation", label: "Unincorporated association" },
  { value: "incorporatedNonProfit", label: "Nonprofit (incorporated)" },
  { value: "unincorporatedNonProfit", label: "Nonprofit (unincorporated)" },
];

/** At most this many people on a business (MAX_REPRESENTATIVES on the server). */
export const PAYEE_MAX_REPRESENTATIVES = 6;

// ------------------------------------------------------------ public session

export interface PayeeSession {
  recipient: {
    id: string;
    name: string;
    status: string | null;
    recipient_type: PayeeRecipientType | string | null;
    bank_linked?: boolean;
    bank_name?: string | null;
    last_four?: string | null;
  };
  onboarding: {
    terms_accepted?: boolean;
    tos_requirement_outstanding?: boolean;
    verification_status?: string | null;
    identity_submitted?: boolean;
    identity_requirements_outstanding?: string[];
    identity_requirements_known?: boolean;
    bank_verified?: boolean;
    bank_status?: string | null;
    bank_verification_status?: string | null;
    bank_micro_deposits_initiated?: boolean;
    bank_can_confirm?: boolean;
    bank_should_initiate?: boolean;
    complete?: boolean;
    status?: string | null;
  };
  payer: { name: string; logo_url: string | null; primary_color?: string | null };
  environment: string;
}

export type PayeeStep = "terms" | "identity" | "bank" | "verify" | "done";

export const PAYEE_STEPS: ReadonlyArray<{ key: PayeeStep; label: string }> = [
  { key: "terms", label: "Terms" },
  { key: "identity", label: "Identity" },
  { key: "bank", label: "Bank" },
  { key: "verify", label: "Verify" },
  { key: "done", label: "Done" },
];

/** The first step this payee still has to do, from the server's session state. */
export function payeeStepFromSession(session: PayeeSession, options: { replaceBank?: boolean } = {}): PayeeStep {
  const o = session.onboarding || {};
  if (o.complete === true) return "done";
  if (o.terms_accepted !== true) return "terms";
  if (o.identity_submitted !== true) return "identity";
  if (options.replaceBank || session.recipient.bank_linked !== true) return "bank";
  if (o.bank_verified !== true) return "verify";
  return "done";
}

/** What the Verify step can do with the bank right now. */
export function payeeVerifyMode(session: PayeeSession): "confirm" | "initiate" | "wait" {
  const o = session.onboarding || {};
  if (o.bank_can_confirm === true || o.bank_micro_deposits_initiated === true) return "confirm";
  if (o.bank_should_initiate === true) return "initiate";
  return "wait";
}

// ------------------------------------------------------------ errors

export interface PayeeErrorBody {
  error?: string;
  message?: string;
  field?: string;
  missing?: string[];
  rejected_fields?: string[];
}

export class PayeeError extends Error {
  code: string;
  status: number | null;
  field: string | null;
  fields: string[];
  constructor(code: string, message: string, status: number | null, field: string | null, fields: string[]) {
    super(message);
    this.name = "PayeeError";
    this.code = code;
    this.status = status;
    this.field = field;
    this.fields = fields;
  }
}

/** Link-level failures: the page cannot continue with this token. */
export const PAYEE_LINK_ERRORS: Record<string, { title: string; message: string }> = {
  link_invalid: {
    title: "This link is not valid",
    message: "Open the full link from your email. If it still does not work, ask the sender for a new link.",
  },
  link_expired: {
    title: "This link has expired",
    message: "Setup links expire for your security. Ask the sender to send you a new link.",
  },
  link_closed: {
    title: "This payment setup was cancelled",
    message: "The sender cancelled this payment setup. Contact them if you think this is a mistake.",
  },
  rate_limited: {
    title: "Too many attempts",
    message: "This link was used too many times. Ask the sender for a new link.",
  },
  payee_environment_mismatch: {
    title: "This link cannot be used here",
    message: "Open the link exactly as it appears in your email.",
  },
};

export const isPayeeLinkError = (code: string | null | undefined): boolean =>
  Boolean(code && Object.prototype.hasOwnProperty.call(PAYEE_LINK_ERRORS, code));

/** Readable names for the identity fields the server reports as missing or rejected. */
const FIELD_LABELS: Record<string, string> = {
  name: "legal name",
  email: "email",
  phone: "phone",
  address: "address",
  birthdate: "date of birth",
  ssn: "Social Security number",
  holder_name: "account holder name",
  routing_number: "routing number",
  account_number: "account number",
  code: "verification code",
  "business.legal_name": "legal business name",
  "business.type": "business type",
  "business.address": "business address",
  "business.phone": "business phone",
  "business.email": "business email",
  "business.ein": "EIN",
  "business.website": "website or description",
  representatives: "owners and controller",
};

export function payeeFieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const rep = /^representatives\[(\d+)\]\.(\w+)$/.exec(field);
  if (rep) {
    const inner = { name: "name", address: "home address", dob: "date of birth", ssn: "SSN", phone: "phone", ownership_pct: "ownership", id: "details" }[rep[2]] || rep[2];
    return `person ${Number(rep[1]) + 1}: ${inner}`;
  }
  // Provider field paths such as individual.ssn / business.taxID.ein: keep the last part readable.
  const last = field.split(".").pop() || field;
  return { ssn: "Social Security number", birthdate: "date of birth", birthDate: "date of birth", ein: "EIN", taxID: "EIN", phone: "phone", address: "address", email: "email" }[last] || last.replace(/_/g, " ");
}

const GENERIC_MESSAGES: Record<string, string> = {
  terms_acceptance_required: "Check the box to accept the terms before continuing.",
  identity_fields_incomplete: "Complete every field to continue.",
  identity_required: "Verify your identity before adding a bank account.",
  tos_required: "Accept the terms before adding a bank account.",
  bank_required: "Add a bank account first.",
  invalid_code: "That code did not match. Check the $0.01 deposit description and try again.",
  invalid_code_format: "Enter the 4-digit verification code.",
  bank_not_verified: "The bank is not verified yet. Try again in a minute.",
  bank_conflict: "This bank account is already set up for another payee.",
  provider_rejected: "These details were not accepted. Check them and try again.",
  payee_setup_unavailable: "Payment setup is temporarily unavailable. Try again shortly.",
  provider_unreachable: "Payment setup is temporarily unavailable. Try again shortly.",
  already_verified: "Your payment details are already verified.",
  tenant_member_required: "Only a member of this organization can set up payees.",
  payee_not_found: "Payee not found.",
  payee_disconnected: "This payee is disconnected.",
  payee_already_verified: "This payee has already finished setup.",
};

/** Builds the error a caller shows. Field errors carry field names only, never values. */
export function payeeErrorFrom(body: PayeeErrorBody | null | undefined, status: number | null, fallback = "Something went wrong. Try again."): PayeeError {
  const code = typeof body?.error === "string" && body.error ? body.error : "request_failed";
  const fields = [
    ...(Array.isArray(body?.missing) ? body!.missing! : []),
    ...(Array.isArray(body?.rejected_fields) ? body!.rejected_fields! : []),
  ].filter((f): f is string => typeof f === "string");
  const field = typeof body?.field === "string" ? body.field : null;
  let message = PAYEE_LINK_ERRORS[code]?.message
    || (typeof body?.message === "string" && body.message ? body.message : "")
    || GENERIC_MESSAGES[code]
    || fallback;
  if (fields.length) {
    message = `${message} Check: ${[...new Set(fields.map(payeeFieldLabel))].join(", ")}.`;
  }
  return new PayeeError(code, message, status, field, fields);
}

type InvokeResult = { data: unknown; error: unknown };

/**
 * Reads a functions.invoke result: the data on success, or throws PayeeError.
 * AWS puts the parsed reply on error.context.body (and data); Supabase puts a
 * Response on error.context.
 */
export async function unwrapPayeeInvoke<T = Record<string, unknown>>(result: InvokeResult, fallback?: string): Promise<T> {
  const data = result.data as (PayeeErrorBody & Record<string, unknown>) | null;
  if (!result.error && !(data && typeof data.error === "string")) return (data ?? {}) as T;
  const context = (result.error as { context?: { status?: number; body?: unknown; clone?: () => { json: () => Promise<unknown> } } } | null)?.context;
  let body: unknown = data && typeof data === "object" ? data : context?.body;
  if ((body === undefined || body === null) && typeof context?.clone === "function") {
    try { body = await context.clone().json(); } catch { body = null; }
  }
  const status = typeof context?.status === "number" ? context.status : null;
  throw payeeErrorFrom((body as PayeeErrorBody) ?? null, status, fallback);
}

// ------------------------------------------------------------ tenant side

/** The external_payment_recipients columns the SPA reads (never secure_token). */
export const PAYEE_ROW_COLUMNS = [
  "id", "stakeholder_account_id", "display_name", "email", "recipient_type", "relationship",
  "onboarding_status", "token_expires_at", "tos_accepted_at", "identity_submitted_at",
  "bank_linked_at", "bank_verified_at", "verified_at", "disconnected_at",
  "provider_bank_name", "provider_last_four", "created_at",
].join(", ");

export interface PayeeRow {
  id: string;
  stakeholder_account_id: string | null;
  display_name: string;
  email: string | null;
  recipient_type: string;
  relationship: string | null;
  onboarding_status: string | null;
  token_expires_at: string | null;
  tos_accepted_at: string | null;
  identity_submitted_at: string | null;
  bank_linked_at: string | null;
  bank_verified_at: string | null;
  verified_at: string | null;
  disconnected_at: string | null;
  provider_bank_name: string | null;
  provider_last_four: string | null;
  created_at?: string | null;
}

export type PayeeStatus = "link_sent" | "link_expired" | "in_progress" | "in_review" | "verified" | "failed" | "disconnected";

export const PAYEE_STATUS_LABEL: Record<PayeeStatus, string> = {
  link_sent: "Link sent",
  link_expired: "Link expired",
  in_progress: "In progress",
  in_review: "In review",
  verified: "Verified",
  failed: "Failed",
  disconnected: "Disconnected",
};

export const PAYEE_STATUS_CLASS: Record<PayeeStatus, string> = {
  link_sent: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  link_expired: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  in_progress: "bg-indigo-500/10 text-indigo-700 border-indigo-500/20",
  in_review: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  verified: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  disconnected: "bg-muted text-muted-foreground border-border",
};

export function payeeStatus(row: PayeeRow, now: number = Date.now()): PayeeStatus {
  if (row.disconnected_at) return "disconnected";
  if (row.verified_at) return "verified";
  if (row.onboarding_status === "failed") return "failed";
  if (row.onboarding_status === "pending_review") return "in_review";
  const expiry = row.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
  if (Number.isFinite(expiry) && expiry < now) return "link_expired";
  if (row.tos_accepted_at || row.identity_submitted_at || row.bank_linked_at) return "in_progress";
  return "link_sent";
}

/** A new link can be sent until the payee is verified or disconnected. */
export const payeeCanResend = (row: PayeeRow): boolean => !row.verified_at && !row.disconnected_at;

/** Which of the payee's steps are done, for a short progress line. */
export function payeeProgress(row: PayeeRow): string {
  const done = [
    row.tos_accepted_at ? "terms" : null,
    row.identity_submitted_at ? "identity" : null,
    row.bank_linked_at ? "bank added" : null,
    row.bank_verified_at ? "bank verified" : null,
  ].filter(Boolean);
  return done.length ? `Done: ${done.join(", ")}` : "Not started";
}

// ------------------------------------------------------------ input helpers

export const onlyDigits = (value: string, max: number): string => value.replace(/\D/g, "").slice(0, max);

/** 10-digit US phone: drops a leading country code 1 (the server keeps the first 10 digits). */
export function usPhoneDigits(value: string): string {
  const d = value.replace(/\D/g, "");
  return (d.length === 11 && d.startsWith("1") ? d.slice(1) : d).slice(0, 10);
}
