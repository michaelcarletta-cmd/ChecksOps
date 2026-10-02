/**
 * WalletOps read-model for Moov treasury sweeps (automatic payouts).
 * Does not create, cancel, or recreate provider transfers.
 *
 * A sweep is Moov sending leftover wallet cash to the settlement bank.
 * The user does not tap Send. Closed sweeps often still have an in-flight
 * ACH credit; only paid/failed/canceled sweeps are finished.
 */

export const AUTOMATIC_PAYOUT_STATUSES_IN_FLIGHT = new Set([
  "accruing",
  "action-required",
  "closed",
  "pending",
]);

export type SweepActivitySource = {
  sweepID?: string | null;
  status?: string | null;
  accruedAmount?: unknown;
  transferAmount?: unknown;
  transferID?: string | null;
  createdOn?: string | null;
  completedOn?: string | null;
  accrualEndedOn?: string | null;
  accrualStartedOn?: string | null;
};

export function sweepTimestamp(sweep: SweepActivitySource): string | null {
  const raw = sweep.completedOn || sweep.accrualEndedOn || sweep.createdOn || sweep.accrualStartedOn;
  const value = String(raw || "").trim();
  return value || null;
}

function moneyObjectCents(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.valueDecimal != null) {
    const n = Number(row.valueDecimal);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  if (row.value != null) {
    const n = Number(row.value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/** Moov sweep amounts arrive as dollar strings ("5.00") or money objects. */
export function sweepAmountCents(sweep: SweepActivitySource): number {
  for (const value of [sweep.transferAmount, sweep.accruedAmount]) {
    const fromObject = moneyObjectCents(value);
    if (fromObject && fromObject > 0) return fromObject;
    if (value == null || value === "" || typeof value === "object") continue;
    const n = Number(String(value).trim());
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return 0;
}

export function isAutomaticPayoutDescription(description?: string | null) {
  return /^sweepID:/i.test(String(description || "").trim());
}

export function isSweepInFlight(status?: string | null) {
  return AUTOMATIC_PAYOUT_STATUSES_IN_FLIGHT.has(String(status || "").toLowerCase());
}

export function summarizeSweepActivity({
  sweeps = [],
  knownTransferIds = [],
  settlementLabel = "Connected bank",
}: {
  sweeps?: SweepActivitySource[];
  knownTransferIds?: Array<string | null | undefined>;
  settlementLabel?: string;
}) {
  const known = new Set(knownTransferIds.map((id) => String(id || "").trim()).filter(Boolean));
  const rows = [];
  let pendingOutCents = 0;

  for (const sweep of sweeps) {
    const amountCents = sweepAmountCents(sweep);
    if (amountCents <= 0) continue;
    const transferId = String(sweep.transferID || "").trim();
    if (transferId && known.has(transferId)) continue;

    const status = String(sweep.status || "pending").toLowerCase();
    const pending = isSweepInFlight(status);
    if (pending) pendingOutCents += amountCents;

    rows.push({
      key: `sweep-${sweep.sweepID || transferId || amountCents}`,
      at: sweepTimestamp(sweep) || new Date().toISOString(),
      title: "Automatic payout",
      subtitle: pending
        ? "Moov sent leftover wallet funds to the bank"
        : "Daily wallet payout",
      detail: `Wallet → ${settlementLabel}`,
      transferId: transferId || null,
      sweepId: sweep.sweepID || null,
      amountCents,
      status,
      pending,
      credit: false,
    });
  }

  return { pendingOutCents, rows };
}

/** WalletOps on/off control derived from the live sweep-config row. */
export function automaticPayoutControl(config: {
  status?: string | null;
  provider_sweep_config_id?: string | null;
} | null | undefined) {
  const id = config?.provider_sweep_config_id ?? null;
  const sweepsOn = String(config?.status ?? "").toLowerCase() === "enabled";
  if (!id) {
    return { show: false, action: null as "enable" | "disable" | null, label: null as string | null, sweepsOn };
  }
  return {
    show: true,
    action: (sweepsOn ? "disable" : "enable") as "enable" | "disable",
    label: sweepsOn ? "Turn off automatic payouts" : "Turn on automatic payouts",
    sweepsOn,
  };
}
