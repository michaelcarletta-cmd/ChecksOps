// Single source of truth for the "Deposit" status label shown across the app.
// Falls back to the raw deposit_status string when there is nothing better.
//
// Rules (in priority order):
//   1. check_stage === 'funds_released' → "Funds Released"
//   2. CheckAlt deposit (127 / Approved → local submitted, or intake deposited):
//      "Submitted" — not bank settlement. CheckAlt has no proven cleared API.
//   3. Non-CheckAlt check_stage === 'deposited' OR deposit_status in
//      (deposited, cleared, settled) → "Cleared"
//   4. deposit_status present → humanized (snake_case → words)
//   5. nothing → "—"

export type DepositLabelInput = {
  check_stage?: string | null;
  deposit_status?: string | null;
  provider?: string | null;
  checkalt_status?: string | null;
  checkalt_deposits?: Array<{ status?: string | null }> | null;
};

/** Local CheckAlt status after 127 / Approved. Not bank settlement. */
export const CHECKALT_SUBMITTED_LABEL = "Submitted";

const latestCheckAltStatus = (c: DepositLabelInput): string => {
  if (c.checkalt_status) return String(c.checkalt_status).toLowerCase();
  const rows = c.checkalt_deposits ?? [];
  for (const row of rows) {
    if (row?.status) return String(row.status).toLowerCase();
  }
  return "";
};

export const isCheckAltDepositLabel = (c: DepositLabelInput | null | undefined): boolean => {
  if (!c) return false;
  if (latestCheckAltStatus(c)) return true;
  if (String(c.provider ?? "").toLowerCase() === "checkalt") return true;
  return Array.isArray(c.checkalt_deposits) && c.checkalt_deposits.length > 0;
};

export function getDepositLabel(c: DepositLabelInput | null | undefined): string {
  if (!c) return "—";
  const stage = (c.check_stage ?? "").toLowerCase();
  const status = (c.deposit_status ?? "").toLowerCase();
  const checkAltStatus = latestCheckAltStatus(c);
  const checkAlt = isCheckAltDepositLabel(c);

  if (stage === "funds_released") return "Funds Released";

  if (checkAlt) {
    if (checkAltStatus === "pending_approval") return "Pending Approval";
    if (checkAltStatus === "rejected" || checkAltStatus === "declined") return "Rejected";
    if (checkAltStatus === "returned") return "Returned";
    if (checkAltStatus === "error") return "Error";
    // Only an actually persisted local cleared row may say Cleared.
    if (checkAltStatus === "cleared") return "Cleared";
    if (
      checkAltStatus === "submitted" ||
      stage === "deposited" ||
      status === "deposited" ||
      status === "submitted"
    ) {
      return CHECKALT_SUBMITTED_LABEL;
    }
  }

  if (stage === "deposited" || status === "deposited" || status === "cleared" || status === "settled") {
    return "Cleared";
  }
  if (c.deposit_status) return c.deposit_status.replace(/_/g, " ");
  if (c.check_stage) return c.check_stage.replace(/_/g, " ");
  return "—";
}
