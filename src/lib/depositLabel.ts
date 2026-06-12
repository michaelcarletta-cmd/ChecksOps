// Single source of truth for the "Deposit" status label shown across the app.
// Falls back to the raw deposit_status string when there is nothing better.
//
// Rules (in priority order):
//   1. check_stage === 'funds_released' → "Funds Released"
//   2. check_stage === 'deposited' OR deposit_status in (deposited, cleared, settled) → "Cleared"
//   3. deposit_status present → humanized (snake_case → words)
//   4. nothing → "—"

export type DepositLabelInput = {
  check_stage?: string | null;
  deposit_status?: string | null;
};

export function getDepositLabel(c: DepositLabelInput | null | undefined): string {
  if (!c) return "—";
  const stage = (c.check_stage ?? "").toLowerCase();
  const status = (c.deposit_status ?? "").toLowerCase();

  if (stage === "funds_released") return "Funds Released";
  if (stage === "deposited" || status === "deposited" || status === "cleared" || status === "settled") {
    return "Cleared";
  }
  if (c.deposit_status) return c.deposit_status.replace(/_/g, " ");
  if (c.check_stage) return c.check_stage.replace(/_/g, " ");
  return "—";
}
