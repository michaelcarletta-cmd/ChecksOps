/**
 * Pure, testable Moov readiness logic.
 *
 * Naomi (Moov) confirmed the minimum bar for the ChecksOps disbursement use
 * case: the merchant account needs `send-funds` (ACH credit) enabled, and
 * `wallet` balance access — which Moov enables automatically once the account
 * is approved. On top of that ChecksOps requires:
 *   - Terms of Service accepted (Moov-hosted onboarding OR the ToS Drop token)
 *   - a bank account that actually completed verification
 *   - no outstanding underwriting / identity requirements
 *
 * This module makes NO network calls so it can be unit tested. Callers pass in
 * the raw provider payloads.
 */

export type ReadinessState = "ready" | "pending" | "action_required" | "not_started";

export interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail?: string | null;
  /** Requirement identifiers Moov reported for this check, if any. */
  requirements?: string[];
}

export interface CapabilityLike {
  capability: string;
  status: string;
  requirements?: { currentlyDue?: string[] | null; errorCode?: string | null } | null;
}

export interface BankLike {
  status?: string | null;
  verification_status?: string | null;
  connection_status?: string | null;
}

/**
 * Moov names capabilities both as bare families (`send-funds`) and, in newer
 * responses, as dotted rail-specific ids (`send-funds.ach`). Treat the family
 * as the unit of readiness: `send-funds.ach` satisfies `send-funds`.
 */
export function capabilityFamily(capability: string): string {
  return String(capability ?? "").split(".")[0];
}

export function findCapability(
  caps: CapabilityLike[] | null | undefined,
  wanted: string,
): CapabilityLike | null {
  const family = capabilityFamily(wanted);
  const list = caps ?? [];
  // Prefer an exact match (e.g. send-funds.ach) then fall back to the family.
  return (
    list.find((c) => String(c.capability).toLowerCase() === wanted.toLowerCase()) ??
    list.find((c) => capabilityFamily(String(c.capability)).toLowerCase() === family.toLowerCase()) ??
    null
  );
}

export function capabilityState(cap: CapabilityLike | null): ReadinessState {
  if (!cap) return "not_started";
  switch (String(cap.status ?? "").toLowerCase()) {
    case "enabled":
      return "ready";
    case "pending":
    case "in-review":
    case "in_review":
      return "pending";
    case "errored":
    case "disconnected":
    case "rejected":
      return "action_required";
    default:
      return "pending";
  }
}

export function currentlyDue(caps: CapabilityLike[] | null | undefined): string[] {
  return (caps ?? [])
    .flatMap((c) => c.requirements?.currentlyDue ?? [])
    .filter((r): r is string => typeof r === "string" && r.length > 0);
}

/** Bank verification is only "ready" when Moov reports the account verified. */
export function bankState(banks: BankLike[] | null | undefined): ReadinessState {
  const list = banks ?? [];
  if (list.length === 0) return "not_started";
  const statuses = list.map((b) =>
    String(b.status ?? b.verification_status ?? b.connection_status ?? "").toLowerCase()
  );
  if (statuses.some((s) => s === "verified")) return "ready";
  if (statuses.some((s) => s === "errored" || s === "failed" || s === "disconnected")) {
    return "action_required";
  }
  return "pending";
}

export interface ReadinessInput {
  environment: string;
  accountId: string | null;
  capabilities: CapabilityLike[] | null;
  banks: BankLike[] | null;
  /** Moov account payload verification block, if present. */
  verificationStatus?: string | null;
  disabled?: boolean;
  /** Whether a ToS acceptance is recorded (hosted onboarding or ToS Drop). */
  termsAccepted: boolean;
  /** Fee plan attached to the merchant, if the platform could read one. */
  feePlanCode?: string | null;
  /** True when the platform account itself exposes no fee plan (Moov-managed). */
  feePlanUnavailable?: boolean;
}

export interface ReadinessResult {
  environment: string;
  isSandbox: boolean;
  /** Money movement should only be offered when this is true. */
  canMoveMoney: boolean;
  overall: ReadinessState;
  checks: ReadinessCheck[];
  requirements: string[];
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const checks: ReadinessCheck[] = [];
  const caps = input.capabilities ?? [];

  if (!input.accountId) {
    checks.push({
      id: "account",
      label: "Payment account created",
      state: "not_started",
      detail: "No payment account yet.",
    });
  } else {
    checks.push({ id: "account", label: "Payment account created", state: "ready" });
  }

  checks.push({
    id: "terms_of_service",
    label: "Terms of service accepted",
    state: input.termsAccepted ? "ready" : input.accountId ? "action_required" : "not_started",
    detail: input.termsAccepted ? null : "The account holder must accept the provider terms.",
  });

  const verification = String(input.verificationStatus ?? "").toLowerCase();
  const verificationState: ReadinessState = input.disabled
    ? "action_required"
    : verification === "verified"
    ? "ready"
    : verification === "failed" || verification === "resubmit" || verification === "errored"
    ? "action_required"
    : verification === "pending" || verification === "review" || verification === "in-review"
    ? "pending"
    : input.accountId
    ? "pending"
    : "not_started";

  const due = currentlyDue(caps);
  checks.push({
    id: "identity_verification",
    label: "Identity & business verification",
    state: due.length > 0 && verificationState !== "ready" ? "action_required" : verificationState,
    detail: input.disabled ? "The provider disabled this account." : verification === "verified" ? "Identity confirmed." : "Standard KYC/KYB identity check.",
    requirements: due,
  });

  const sendFunds = findCapability(caps, "send-funds.ach");
  checks.push({
    id: "send_funds_ach",
    label: "Send funds via ACH",
    state: capabilityState(sendFunds),
    detail: sendFunds ? null : "Standard ACH capability not requested or not yet returned.",
    requirements: sendFunds?.requirements?.currentlyDue ?? [],
  });

  const sameDaySend = findCapability(caps, "send-funds.ach.same-day");
  if (sameDaySend) {
    checks.push({
      id: "send_funds_ach_sameday",
      label: "Same-day ACH Sending",
      state: capabilityState(sameDaySend),
      detail: sameDaySend.status === "enabled" ? "Active" : "Same-day ACH requires additional review.",
    });
  }

  const collectFunds = findCapability(caps, "collect-funds.ach");
  checks.push({
    id: "collect_funds_ach",
    label: "Collect funds via ACH",
    state: capabilityState(collectFunds),
    detail: collectFunds ? null : "ACH collection not requested or not yet returned.",
    requirements: collectFunds?.requirements?.currentlyDue ?? [],
  });

  const wallet = findCapability(caps, "wallet.balance");
  checks.push({
    id: "wallet_balance",
    label: "Wallet balance (hold funds)",
    state: capabilityState(wallet),
    detail: wallet
      ? null
      : "Enabled automatically by the provider once the account is approved.",
  });

  const bank = bankState(input.banks);
  checks.push({
    id: "bank_verified",
    label: "Settlement bank verified",
    state: bank,
    detail: bank === "pending"
      ? "Linked, waiting on the provider to complete verification."
      : bank === "not_started"
      ? "No bank connected yet."
      : null,
  });

  checks.push({
    id: "fee_plan",
    label: "Fee plan assigned",
    state: input.feePlanCode ? "ready" : input.feePlanUnavailable ? "pending" : "pending",
    detail: input.feePlanCode
      ? `Plan ${input.feePlanCode}`
      : "Fee plans are provisioned by the payment provider, not self-serve. Onboarding is not blocked by this.",
  });

  // Fee plan never blocks money movement — it is provider-managed.
  const blocking = checks.filter((c) => c.id !== "fee_plan");
  const canMoveMoney =
    blocking.every((c) => c.state === "ready") ||
    // Wallet balance is auto-granted post-approval; don't block ACH sends on it.
    (blocking
      .filter((c) => c.id !== "wallet_balance")
      .every((c) => c.state === "ready"));

  const overall: ReadinessState = canMoveMoney
    ? "ready"
    : blocking.some((c) => c.state === "action_required")
    ? "action_required"
    : blocking.some((c) => c.state === "not_started") && !input.accountId
    ? "not_started"
    : "pending";

  return {
    environment: input.environment,
    isSandbox: String(input.environment).toLowerCase() !== "production",
    canMoveMoney,
    overall,
    checks,
    requirements: Array.from(new Set(due)),
  };
}
