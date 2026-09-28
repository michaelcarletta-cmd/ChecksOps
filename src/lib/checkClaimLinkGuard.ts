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

/** Existing linked claims rename in place. Unlinked checks still link or create. */
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
