/**
 * Moov capability IDs for API v2025.07.00+.
 *
 * Moov deprecated the family IDs `send-funds`, `collect-funds`, and `wallet`.
 * Request the rail-specific replacements that ChecksOps actually uses:
 * ACH collection, ACH disbursement, and wallet balance.
 *
 * Recipients stay on `transfers` only. Requesting send/collect on a payee
 * adds platform-agreement and full-KYC requirements they do not need.
 *
 * @see https://docs.moov.io/guides/accounts/capabilities/reference/
 */
export const MOOV_CAPABILITIES_API_VERSION = "v2025.07.00";

export const LEGACY_CAPABILITY_IDS = ["send-funds", "collect-funds", "wallet"] as const;

/** Tenant/merchant accounts: collect rent, pay stakeholders, hold funds. */
export const MERCHANT_CAPABILITIES = [
  "transfers",
  "collect-funds.ach",
  "send-funds.ach",
  "wallet.balance",
] as const;

/** Receive-only stakeholders and payees. */
export const RECIPIENT_CAPABILITIES = ["transfers"] as const;

/** Individual payer that ChecksOps debits (homeowner deductible). */
export const COLLECT_ACH_CAPABILITIES = ["transfers", "collect-funds.ach"] as const;

export type CapabilityLike = { capability?: string | null; status?: string | null };

export function capabilityEnabled(
  caps: CapabilityLike[] | null | undefined,
  wanted: string,
): boolean {
  const target = String(wanted ?? "").toLowerCase();
  if (!target) return false;
  return (caps ?? []).some((row) => {
    if (String(row?.status ?? "").toLowerCase() !== "enabled") return false;
    const name = String(row?.capability ?? "").toLowerCase();
    return name === target || name.startsWith(`${target}.`);
  });
}

export function capabilityFlags(
  caps: Array<{ capability: string; status: string }> | null | undefined,
) {
  return {
    can_receive_payments: capabilityEnabled(caps, "transfers") || capabilityEnabled(caps, "collect-funds"),
    can_send_payments: capabilityEnabled(caps, "transfers") || capabilityEnabled(caps, "send-funds"),
    can_ach_debit: capabilityEnabled(caps, "collect-funds"),
    can_ach_credit: capabilityEnabled(caps, "send-funds"),
    restricted: (caps ?? []).some((c) => c.status === "disconnected"),
    disabled: (caps ?? []).length > 0 && (caps ?? []).every((c) => c.status !== "enabled"),
  };
}

/** Exact granular IDs not yet present on the account. Legacy family IDs do not count. */
export function missingRequestedCapabilities(
  caps: CapabilityLike[] | null | undefined,
  required: readonly string[] = MERCHANT_CAPABILITIES,
): string[] {
  const have = new Set(
    (caps ?? []).map((row) => String(row?.capability ?? "").toLowerCase()).filter(Boolean),
  );
  return required.filter((id) => !have.has(String(id).toLowerCase()));
}
