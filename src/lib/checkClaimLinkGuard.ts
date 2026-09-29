/** Narrow multi-tenant claim-link guard. Ownership is claims.org_id only. */

export type CheckClaimLinkReason =
  | "unlinked"
  | "same_org"
  | "cross_org"
  | "unassigned_claim"
  | "missing_claim"
  | "missing_check_tenant";

export type CheckClaimLinkDecision = {
  allowed: boolean;
  reason: CheckClaimLinkReason;
};

export const CHECK_CLAIM_LINK_DENIED = "check_claim_link_denied";

export function evaluateCheckClaimLink(opts: {
  checkTenantId?: string | null;
  claimId?: string | null;
  claimExists?: boolean;
  claimOrgId?: string | null;
}): CheckClaimLinkDecision {
  if (opts.claimId == null || opts.claimId === "") {
    return { allowed: true, reason: "unlinked" };
  }
  if (opts.claimExists === false) {
    return { allowed: false, reason: "missing_claim" };
  }
  if (!opts.checkTenantId) {
    return { allowed: false, reason: "missing_check_tenant" };
  }

  if (!opts.claimOrgId) {
    return { allowed: false, reason: "unassigned_claim" };
  }
  if (String(opts.claimOrgId) !== String(opts.checkTenantId)) {
    return { allowed: false, reason: "cross_org" };
  }
  return { allowed: true, reason: "same_org" };
}

export function assertCheckClaimLinkAllowed(opts: Parameters<typeof evaluateCheckClaimLink>[0]) {
  const decision = evaluateCheckClaimLink(opts);
  if (!decision.allowed) {
    const error = new Error(`${CHECK_CLAIM_LINK_DENIED}: ${decision.reason}`);
    (error as Error & { decision: CheckClaimLinkDecision }).decision = decision;
    throw error;
  }
  return decision;
}

export function isCheckClaimLinkDenied(error: { message?: string; code?: string } | null | undefined) {
  return String(error?.message || "").includes(CHECK_CLAIM_LINK_DENIED);
}

export function claimLinkUserMessage(reason: CheckClaimLinkReason | string) {
  switch (reason) {
    case "cross_org":
      return "This claim belongs to another tenant. The check was not linked.";
    case "unassigned_claim":
      return "This legacy claim has no tenant assigned. Ask an owner to set the claim organization before linking.";
    case "missing_claim":
      return "That claim does not exist. The check was not linked.";
    case "missing_check_tenant":
      return "This check has no tenant, so it cannot be linked to a claim.";
    default:
      return "The claim link was rejected. The check was not changed.";
  }
}

export function claimIsSelectableForTenant(
  claim: { org_id?: string | null } | null | undefined,
  tenantId?: string | null,
) {
  if (!claim || !tenantId) return false;
  if (!claim.org_id) return false;
  return String(claim.org_id) === String(tenantId);
}

export function filterSelectableClaims<T extends { org_id?: string | null }>(
  claims: T[] = [],
  tenantId?: string | null,
) {
  return claims.filter((claim) => claimIsSelectableForTenant(claim, tenantId));
}

export function newTrackingClaimInsert(claimNumber: string, checkTenantId: string) {
  if (!checkTenantId) {
    throw new Error(`${CHECK_CLAIM_LINK_DENIED}: missing_check_tenant`);
  }
  return {
    claim_number: claimNumber,
    status: "tracking" as const,
    org_id: checkTenantId,
  };
}

export type ClaimNumberSavePlan =
  | { mode: "update_existing"; claimId: string; claimNumber: string }
  | { mode: "link_or_create"; claimNumber: string };

export const CLAIM_NUMBER_SAVE_SELECT =
  "id, claim_number, policyholder_name, org_id, status, insurance_company, policyholder_address";

export const CLAIM_LEDGER_NOT_LINKED =
  "This check is not linked to a claim.";

export type ClaimLedgerLinkAction = "inspect" | "link_existing" | "create_new";

export const CLAIM_LEDGER_LINK_RPC = "claim_ledger_link_or_create";

export function claimLedgerLinkOrCreateArgs(opts: {
  checkId: string;
  claimNumber: string;
  action: ClaimLedgerLinkAction;
}) {
  const claimNumber = String(opts.claimNumber || "").trim();
  if (!claimNumber) {
    throw new Error("Enter a claim number");
  }
  if (!opts.checkId) {
    throw new Error("Missing check");
  }
  if (!["inspect", "link_existing", "create_new"].includes(opts.action)) {
    throw new Error("Invalid Claim Ledger action");
  }
  return {
    p_check_id: String(opts.checkId),
    p_claim_number: claimNumber,
    p_action: opts.action,
  };
}

export function claimLedgerUserMessage(code: string | null | undefined) {
  switch (code) {
    case "existing_found":
      return "An existing claim already uses that number. Link it instead of creating a new ledger.";
    case "no_match":
      return "No existing claim with that number was found for this tenant.";
    case "ambiguous":
      return "More than one claim matches that number. The check was not linked.";
    case "cross_tenant":
      return "That claim number belongs to another tenant. The check was not linked.";
    case "claim_number_conflict":
      return "Another claim already uses that number. A new ledger was not created.";
    case "already_linked":
      return "This check is already linked to a claim.";
    case "check_not_found":
    case "tenant_mismatch":
      return "This check was not found or is not writable.";
    case "invalid_args":
    case "invalid_action":
      return "Enter a claim number and choose Find, Link, or Start New Ledger.";
    default:
      return "The Claim Ledger action was rejected. The check was not changed.";
  }
}

/**
 * Authoritative ChecksOps link is check_intake_items.claim_id.
 * Prefer the live row, then the already-loaded claim, then the parent prop.
 * Do not invent a UUID from a displayed/OCR claim number.
 */
export function resolveAuthoritativeClaimId(opts: {
  liveCheckClaimId?: string | null;
  loadedClaimId?: string | null;
  claimIdProp?: string | null;
}) {
  return opts.liveCheckClaimId || opts.loadedClaimId || opts.claimIdProp || null;
}

/** Existing linked claims rename in place. Unlinked checks use claim_ledger_link_or_create. */
export function planClaimNumberSave(opts: {
  existingClaimId?: string | null;
  claimNumber: string;
}): ClaimNumberSavePlan {
  const claimNumber = String(opts.claimNumber || "").trim();
  if (!claimNumber) {
    throw new Error("Enter a claim number");
  }
  if (opts.existingClaimId) {
    return { mode: "update_existing", claimId: String(opts.existingClaimId), claimNumber };
  }
  return { mode: "link_or_create", claimNumber };
}

/** POST /data/write body for Claim Ledger Change → Save. Insert is never produced. */
export function claimNumberSaveWritePayload(plan: ClaimNumberSavePlan) {
  if (plan.mode !== "update_existing") {
    throw new Error("Claim Ledger Save only writes an in-place claim_number update");
  }
  return {
    table: "claims" as const,
    op: "update" as const,
    values: { claim_number: plan.claimNumber },
    filters: [{ column: "id", op: "eq" as const, value: plan.claimId }],
    single: true,
    select: CLAIM_NUMBER_SAVE_SELECT,
  };
}

export function resolveAutoLinkCandidate(opts: {
  freedomClaimId?: string | null;
  freedomClaimNumber?: string | null;
  detectedClaimNumber?: string | null;
  claims?: Array<{ id: string; claim_number?: string | null }>;
}) {
  const claims = opts.claims ?? [];
  if (opts.freedomClaimId) {
    const byId = claims.find((claim) => String(claim.id) === String(opts.freedomClaimId));
    if (byId) return byId.id;
  }
  const needles = [opts.freedomClaimNumber, opts.detectedClaimNumber]
    .map((value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase())
    .filter(Boolean);
  for (const needle of needles) {
    const match = claims.find((claim) => (
      String(claim.claim_number || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase() === needle
    ));
    if (match) return match.id;
  }
  return null;
}
