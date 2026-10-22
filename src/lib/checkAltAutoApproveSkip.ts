/**
 * Plain words for why a Check Alt deposit was not approved automatically.
 *
 * Auto-approve is always on (2026-10-22). Submit records a short classified
 * code in checkalt_deposits.last_status_payload._auto_approve.skip_reason
 * (aws/functions/api/providers/production/checkalt-submit.mjs). A deposit that
 * Check Alt flagged, or did not rate Low Risk, waits in the Check Alt portal.
 * The setting and ceiling codes are kept for rows submitted before always-on.
 */
const SKIP_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  flagged_by_checkalt: "Check Alt flagged this check",
  risk_not_low: "Check Alt did not rate it Low Risk",
  not_pending_approval: "Check Alt did not ask for approval when it was submitted",
  missing_reference: "Check Alt did not return a reference number",
  invalid_reference: "Check Alt did not return a usable reference number",
  invalid_amount: "The deposit amount could not be confirmed",
  provider_declined: "Check Alt declined the automatic approval",
  locked_exhausted: "Check Alt was still processing the check when ChecksOps tried to approve it",
  auth_failed: "ChecksOps could not sign in to Check Alt to approve it",
  auto_approve_timeout: "Check Alt did not answer the automatic approval in time",
  auto_approve_error: "The automatic approval did not go through",
  auto_approve_persist_failed: "ChecksOps could not record the automatic approval, so it did not send it",
  // Rows submitted before auto-approve was always on.
  auto_approve_disabled: "Submitted while auto-approve was off for this organization",
  missing_auto_approve_ceiling: "Submitted before auto-approve was always on (no amount limit was set)",
  over_max_amount: "Submitted before auto-approve was always on (over the old amount limit)",
});

export function checkAltAutoApproveSkipText(lastStatusPayload: unknown): string | null {
  if (!lastStatusPayload || typeof lastStatusPayload !== "object") return null;
  const auto = (lastStatusPayload as { _auto_approve?: unknown })._auto_approve;
  if (!auto || typeof auto !== "object") return null;
  const { phase, approved, skip_reason: reason } = auto as {
    phase?: unknown;
    approved?: unknown;
    skip_reason?: unknown;
  };
  if (approved === true) return null;
  if (typeof reason === "string" && reason) {
    return SKIP_REASON_TEXT[reason] ?? "Not approved automatically";
  }
  if (phase === "attempting") return "ChecksOps started the automatic approval but did not get an answer";
  return null;
}
