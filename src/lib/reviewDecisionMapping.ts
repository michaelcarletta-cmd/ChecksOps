/** Maps Review UI deposit paths to persisted intake status/stage/recommendation.
 *  Keep in lockstep with submit_check_review_decision().
 *  AWS T5 must continue to deny voided — this mapping is Lovable-only.
 */

export type ReviewDecisionMapping = {
  status: string | "keep";
  check_stage: string | "keep";
  deposit_recommendation: string | "keep";
  auditEvent: "review_decision" | "decision_reverted";
};

const KEEP = "keep" as const;

export function mapReviewDepositPath(
  depositPath: string,
  current: { status?: string | null; check_stage?: string | null; deposit_recommendation?: string | null } = {},
): ReviewDecisionMapping {
  const path = String(depositPath || "").trim();
  if (path === "voided") {
    return {
      status: "voided",
      check_stage: "review",
      deposit_recommendation: KEEP,
      auditEvent: "review_decision",
    };
  }
  if (path === "endorsements_in_progress") {
    return { status: "endorsements_in_progress", check_stage: "endorsing", deposit_recommendation: "endorsements_pending", auditEvent: "review_decision" };
  }
  if (path === "approved_for_deposit") {
    return { status: "approved_for_deposit", check_stage: "ready_for_deposit", deposit_recommendation: "ready_for_deposit", auditEvent: "review_decision" };
  }
  if (path === "branch_deposit_required") {
    return { status: "branch_deposit_required", check_stage: "ready_for_deposit", deposit_recommendation: "branch_deposit_recommended", auditEvent: "review_decision" };
  }
  if (path === "loss_draft_required") {
    return { status: "loss_draft_required", check_stage: "loss_draft", deposit_recommendation: "loss_draft_required", auditEvent: "review_decision" };
  }
  if (path === "reissue_requested") {
    return { status: "reissue_requested", check_stage: "review", deposit_recommendation: "request_reissue", auditEvent: "review_decision" };
  }
  if (path === "hold_for_claim_review") {
    return { status: "needs_review", check_stage: "review", deposit_recommendation: KEEP, auditEvent: "review_decision" };
  }
  if (path === "revert_to_review") {
    return { status: "needs_review", check_stage: "review", deposit_recommendation: KEEP, auditEvent: "decision_reverted" };
  }
  return {
    status: current.status || KEEP,
    check_stage: current.check_stage || KEEP,
    deposit_recommendation: current.deposit_recommendation || KEEP,
    auditEvent: "review_decision",
  };
}

export function reviewVoidPersistedState(current: { deposit_recommendation?: string | null } = {}) {
  const mapped = mapReviewDepositPath("voided", current);
  return {
    status: mapped.status,
    check_stage: mapped.check_stage,
    deposit_recommendation: mapped.deposit_recommendation === "keep"
      ? (current.deposit_recommendation ?? null)
      : mapped.deposit_recommendation,
    decision: "voided",
    deposit_path: "voided",
    auditEvent: mapped.auditEvent,
  };
}
