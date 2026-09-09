/**
 * Slim Review Queue list projection.
 *
 * The Review tab previously selected `*, check_payees(*)` for every tenant
 * intake row. After child tenant_id backfill, nested payees (and SELECT *
 * OCR jsonb) push that response over the Lambda ~6MB cap.
 *
 * List rows only need the columns used to filter, group, search, and badge
 * the queue. The decision panel still loads a single check with a full row.
 */

export const REVIEW_QUEUE_INTAKE_COLUMNS = [
  "id",
  "tenant_id",
  "claim_id",
  "carrier_name",
  "check_number",
  "amount",
  "issue_date",
  "payee_line",
  "is_multi_payee",
  "ocr_status",
  "ocr_needs_verification",
  "deposit_recommendation",
  "deposit_recommendation_reasons",
  "status",
  "check_stage",
  "created_at",
  "detected_claim_number",
  "partner_status",
  "partner_status_label",
  "external_origin",
  "funds_type",
] as const;

export const REVIEW_QUEUE_PAYEE_COLUMNS = "payee_name, payee_type, endorsement_status";

export const REVIEW_QUEUE_SELECT = `${REVIEW_QUEUE_INTAKE_COLUMNS.join(", ")}, check_payees(${REVIEW_QUEUE_PAYEE_COLUMNS})`;

export type ReviewQueuePayee = {
  payee_name?: string | null;
  payee_type?: string | null;
  endorsement_status?: string | null;
};

export type ReviewQueueRow = {
  status?: string | null;
  check_stage?: string | null;
  ocr_status?: string | null;
  ocr_needs_verification?: boolean | null;
  deposit_recommendation?: string | null;
  partner_status?: string | null;
  external_origin?: Record<string, unknown> | null;
  check_payees?: ReviewQueuePayee[] | null;
};

const isMirroredCheck = (check: ReviewQueueRow) =>
  !!check.external_origin && typeof check.external_origin === "object" &&
  (check.external_origin as { source_app?: string }).source_app === "freedom_crm";

const lifecycleRank = (s: string | null | undefined): number => {
  switch ((s || "").toLowerCase()) {
    case "deposited": case "released": return 50;
    case "approved_for_deposit": case "endorsed": return 40;
    case "endorsements_in_progress": case "endorsement_pending": return 30;
    case "loss_draft_required": return 25;
    case "needs_review": case "in_review": case "ocr_complete": return 20;
    case "held": return 15;
    case "received": case "processing": case "uploaded": return 10;
    case "voided": case "returned": return 5;
    default: return 0;
  }
};

export const getEffectiveStatus = (check: ReviewQueueRow): string => {
  if (isMirroredCheck(check) && check.partner_status) {
    return lifecycleRank(check.status) >= lifecycleRank(check.partner_status)
      ? String(check.status)
      : check.partner_status;
  }
  return String(check.status ?? "");
};

/** Same routing exclusions as the Review tab list (not the Command Center lane). */
export const isInReviewQueue = (check: ReviewQueueRow): boolean => {
  const effectiveStatus = getEffectiveStatus(check);
  const stage = check.check_stage ?? undefined;
  if (
    stage === "loss_draft" ||
    stage === "reissue" ||
    stage === "branch" ||
    stage === "deposited" ||
    stage === "endorsing" ||
    effectiveStatus === "loss_draft_required" ||
    effectiveStatus === "reissue_requested" ||
    effectiveStatus === "branch_deposit_required" ||
    effectiveStatus === "deposited" ||
    effectiveStatus === "endorsements_in_progress" ||
    effectiveStatus === "approved_for_deposit"
  ) {
    return false;
  }
  return (
    stage === "review" ||
    effectiveStatus === "needs_review" ||
    effectiveStatus === "in_review" ||
    effectiveStatus === "ocr_complete" ||
    effectiveStatus === "manual_review_required" ||
    effectiveStatus === "endorsements_complete" ||
    effectiveStatus === "uploaded" ||
    check.ocr_status === "failed"
  );
};

export const reviewQueuePayeeReasons = (payees: ReviewQueuePayee[] | null | undefined): string[] => {
  const reasons: string[] = [];
  if (payees?.some((p) => p.endorsement_status === "rejected")) reasons.push("Rejected endorsement");
  if (payees?.some((p) => p.payee_type === "mortgage_company")) reasons.push("Mortgage payee");
  if ((payees?.length ?? 0) >= 3) reasons.push("3+ payees");
  if (payees?.some((p) => p.payee_type === "other")) reasons.push("Unclear payee classification");
  return reasons;
};
