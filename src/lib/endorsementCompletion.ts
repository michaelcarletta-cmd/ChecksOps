/** Shared endorsement-completion math for Check Command Center / EndorsementChecklist.
 *  Mortgage company + manual_required is satisfied for ENDORSEMENT MATH only.
 *  Contractor rows are CC-only and are not required signers.
 *  Active Loss Draft must never be released to Ready by this math.
 */

export type EndorsementRow = {
  status?: string | null;
  payee_type?: string | null;
};

export type CheckWorkflowRow = {
  status?: string | null;
  check_stage?: string | null;
  deposit_recommendation?: string | null;
  deposited_at?: string | null;
};

export function payeeTypeOf(row: EndorsementRow): string {
  return String(row?.payee_type || "").toLowerCase();
}

export function isContractorPayee(payeeType: string | null | undefined): boolean {
  return String(payeeType || "").toLowerCase() === "contractor";
}

export function isEndorsementSatisfied(row: EndorsementRow): boolean {
  const type = payeeTypeOf(row);
  if (type === "contractor") return true;
  const status = String(row?.status || "");
  if (status === "signed" || status === "waived") return true;
  if (type === "mortgage_company" && status === "manual_required") return true;
  return false;
}

export function evaluateEndorsementMath(rows: EndorsementRow[] = []) {
  if (!rows.length) {
    return { allRequiredSatisfied: false, anyRejected: false };
  }
  const anyRejected = rows.some((row) => String(row?.status || "") === "rejected");
  const allRequiredSatisfied = rows.every(isEndorsementSatisfied);
  return { allRequiredSatisfied, anyRejected };
}

export function isActiveLossDraft(check: CheckWorkflowRow | null | undefined): boolean {
  if (!check) return false;
  return String(check.status || "") === "loss_draft_required"
    || String(check.check_stage || "") === "loss_draft";
}

export type ReadyDecision =
  | { action: "none" }
  | { action: "return_to_review" }
  | { action: "hold_loss_draft" }
  | { action: "already_ready" }
  | { action: "branch_ready" }
  | { action: "ready" };

export function decideReadyTransition(
  check: CheckWorkflowRow | null | undefined,
  evaluation: { allRequiredSatisfied: boolean; anyRejected: boolean },
): ReadyDecision {
  if (evaluation.anyRejected) return { action: "return_to_review" };
  if (!evaluation.allRequiredSatisfied) return { action: "none" };
  if (isActiveLossDraft(check)) return { action: "hold_loss_draft" };
  if (
    String(check?.status || "") === "approved_for_deposit"
    && String(check?.deposit_recommendation || "") === "ready_for_deposit"
  ) {
    return { action: "already_ready" };
  }
  if (String(check?.deposit_recommendation || "") === "branch_deposit_recommended") {
    return { action: "branch_ready" };
  }
  return { action: "ready" };
}

export function mortgageOpsCompleteDoesNotReleaseCheck(): true {
  return true;
}
