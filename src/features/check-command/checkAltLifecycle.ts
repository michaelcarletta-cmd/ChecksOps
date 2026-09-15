/**
 * Authoritative CheckAlt post-submission UI derivation.
 *
 * Command Center Deposit / Ready-lane / labels must come from
 * checkalt_deposits (RDS), never session or localStorage.
 * Does not write check_intake_items.
 */

import type { CheckAltDepositSummary, CheckItem } from "./types";

export const CHECKALT_DEPOSITS_EMBED =
  "checkalt_deposits(id, status, checkalt_reference, submitted_at, approved_at, updated_at, last_status_payload, status_unresolved, provider_http_attempted_at, failure_class)";

export const POST_SUBMISSION_CHECKALT_STATUSES = Object.freeze([
  "pending_approval",
  "submitted",
  "approved",
  "processing",
  "deposited",
  "cleared",
  "settled",
  "submitting",
] as const);

const CHECKALT_NUMERIC_STATUS: Record<number, string> = {
  40: "pending_approval",
  120: "rejected",
  127: "submitted",
  200: "cleared",
};

const CHECKALT_STRING_STATUS: Record<string, string> = {
  submitted: "submitted",
  pending: "submitted",
  pending_approval: "pending_approval",
  processing: "processing",
  approved: "approved",
  deposited: "deposited",
  cleared: "cleared",
  settled: "cleared",
  returned: "returned",
  rejected: "rejected",
  declined: "rejected",
  submitting: "submitting",
  duplicate: "duplicate",
  error: "error",
};

const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Pending Approval",
  submitted: "Submitted",
  processing: "Processing",
  approved: "Approved",
  deposited: "Deposited",
  cleared: "Cleared",
  settled: "Cleared",
  submitting: "Submitting",
  rejected: "Rejected",
  returned: "Returned",
  error: "Error",
  duplicate: "Duplicate",
};

export const canonicalizeCheckAltStatusToken = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

export const normalizeCheckAltStatus = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && CHECKALT_NUMERIC_STATUS[numeric]) {
    return CHECKALT_NUMERIC_STATUS[numeric];
  }
  const token = canonicalizeCheckAltStatusToken(value);
  return CHECKALT_STRING_STATUS[token] ?? null;
};

export const normalizeCheckAltStatusFromPayload = (
  payload?: Record<string, unknown> | null,
): string | null => {
  if (!payload || typeof payload !== "object") return null;
  return (
    normalizeCheckAltStatus(payload.statusCode)
    ?? normalizeCheckAltStatus(payload.status)
    ?? normalizeCheckAltStatus(payload.statusDescription)
  );
};

const payloadFlag = (payload: Record<string, unknown> | null | undefined, key: string): boolean => {
  const value = payload?.[key];
  return value === true || value === "true" || value === "t" || value === 1;
};

const payloadText = (payload: Record<string, unknown> | null | undefined, key: string): string =>
  String(payload?.[key] ?? "").trim().toLowerCase();

export const checkAltReferenceOf = (deposit: CheckAltDepositSummary | null | undefined): string | null => {
  const raw = deposit?.checkalt_reference;
  if (raw == null) return null;
  const value = String(raw).trim();
  return value || null;
};

export const normalizedCheckAltDepositStatus = (
  deposit: CheckAltDepositSummary | null | undefined,
): string | null => {
  if (!deposit) return null;
  return (
    normalizeCheckAltStatus(deposit.status)
    ?? normalizeCheckAltStatusFromPayload(deposit.last_status_payload)
  );
};

export const isUncertainCheckAltDeposit = (
  deposit: CheckAltDepositSummary | null | undefined,
): boolean => {
  if (!deposit) return false;
  if (deposit.status_unresolved === true) return true;
  const payload = deposit.last_status_payload;
  if (payloadFlag(payload, "uncertain")) return true;
  if (payloadText(payload, "error") === "reconciliation_required") return true;
  if (payloadText(payload, "failure_class") === "provider_timeout") return true;
  if (payloadText(payload, "failure_class") === "db_after_provider") return true;
  if (String(deposit.failure_class || "").toLowerCase() === "provider_timeout") return true;
  if (String(deposit.failure_class || "").toLowerCase() === "db_after_provider") return true;
  const status = normalizedCheckAltDepositStatus(deposit);
  if (status === "submitting") return true;
  if (status === "error" && (
    Boolean(deposit.provider_http_attempted_at)
    || payloadFlag(payload, "provider_http_attempted")
    || Boolean(checkAltReferenceOf(deposit))
  )) return true;
  return false;
};

export const providerExecutionMayHaveOccurred = (
  deposit: CheckAltDepositSummary | null | undefined,
): boolean => {
  if (!deposit) return false;
  if (checkAltReferenceOf(deposit)) return true;
  if (deposit.provider_http_attempted_at) return true;
  if (payloadFlag(deposit.last_status_payload, "provider_http_attempted")) return true;
  if (isUncertainCheckAltDeposit(deposit)) return true;
  const status = normalizedCheckAltDepositStatus(deposit);
  if (status && (POST_SUBMISSION_CHECKALT_STATUSES as readonly string[]).includes(status)) {
    return true;
  }
  return false;
};

export const getLatestCheckAltDeposit = (c: CheckItem): CheckAltDepositSummary | null => {
  const deposits = c.checkalt_deposits ?? [];
  if (deposits.length === 0) return null;
  return [...deposits].sort((a, b) => {
    const aTime = new Date(a.updated_at ?? a.approved_at ?? a.submitted_at ?? 0).getTime();
    const bTime = new Date(b.updated_at ?? b.approved_at ?? b.submitted_at ?? 0).getTime();
    return bTime - aTime;
  })[0] ?? null;
};

export const hasAuthoritativeCheckAltSubmission = (c: CheckItem): boolean =>
  providerExecutionMayHaveOccurred(getLatestCheckAltDeposit(c));

export const normalCheckAltDepositAllowed = (c: CheckItem): boolean =>
  !hasAuthoritativeCheckAltSubmission(c);

export const formatCheckAltStatusLabel = (status: string | null | undefined): string => {
  if (!status) return "Unknown";
  const normalized = normalizeCheckAltStatus(status) ?? canonicalizeCheckAltStatusToken(status);
  return STATUS_LABEL[normalized] ?? normalized.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
};

export const formatCheckAltLifecycleLabel = (
  deposit: CheckAltDepositSummary | null | undefined,
): string | null => {
  if (!deposit) return null;
  const reference = checkAltReferenceOf(deposit);
  const refPart = reference ? ` — Ref #${reference}` : "";
  if (isUncertainCheckAltDeposit(deposit)) {
    return `CheckAlt: Reconciliation required${refPart}`;
  }
  const status = normalizedCheckAltDepositStatus(deposit);
  return `CheckAlt: ${formatCheckAltStatusLabel(status)}${refPart}`;
};

export const checkAltLifecycleLabelForCheck = (c: CheckItem): string | null =>
  formatCheckAltLifecycleLabel(getLatestCheckAltDeposit(c));
