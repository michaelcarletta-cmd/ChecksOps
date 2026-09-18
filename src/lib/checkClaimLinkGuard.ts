/** Narrow multi-tenant claim-link guard. Not an ownership-inference model. */

export type CheckClaimLinkReason =
  | "unlinked"
  | "same_org"
  | "legacy_same_tenant"
  | "cross_org"
  | "legacy_unassigned"
  | "conflicting_tenants"
  | "missing_claim"
  | "missing_check_tenant";

export type CheckClaimLinkDecision = {
  allowed: boolean;
  reason: CheckClaimLinkReason;
};

export const CHECK_CLAIM_LINK_DENIED = "check_claim_link_denied";

export function collectDeterministicClaimTenants(
  tenantIds: Array<string | null | undefined> = [],
): string[] {
  return Array.from(new Set(tenantIds.filter((id): id is string => Boolean(id)).map((id) => String(id))));
}

export function evaluateCheckClaimLink(opts: {
  checkTenantId?: string | null;
  claimId?: string | null;
  claimExists?: boolean;
  claimOrgId?: string | null;
  deterministicTenantIds?: string[];
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

  if (opts.claimOrgId) {
    if (String(opts.claimOrgId) !== String(opts.checkTenantId)) {
      return { allowed: false, reason: "cross_org" };
    }
    return { allowed: true, reason: "same_org" };
  }

  const tenants = collectDeterministicClaimTenants(opts.deterministicTenantIds);
  if (tenants.length === 0) {
    return { allowed: false, reason: "legacy_unassigned" };
  }
  if (tenants.length > 1) {
    return { allowed: false, reason: "conflicting_tenants" };
  }
  if (String(tenants[0]) !== String(opts.checkTenantId)) {
    return { allowed: false, reason: "cross_org" };
  }
  return { allowed: true, reason: "legacy_same_tenant" };
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
    case "conflicting_tenants":
      return "This claim belongs to another tenant. The check was not linked.";
    case "legacy_unassigned":
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
  return {
    claim_number: claimNumber,
    status: "tracking" as const,
    org_id: checkTenantId,
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
