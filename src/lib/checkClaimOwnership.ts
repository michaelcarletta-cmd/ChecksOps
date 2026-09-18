/** Product claim-tenant model. Do not treat claims.org_id as the only owner key. */

export type ClaimTenantSource =
  | "intake"
  | "check_case"
  | "org_id"
  | "ledger_event"
  | "claim_check"
  | "claim_payment";

export type ClaimTenantSignal = {
  source: ClaimTenantSource;
  tenantId: string;
  checkId?: string | null;
};

export type CheckClaimLinkDecision = {
  allowed: boolean;
  reason:
    | "unlinked"
    | "first_link"
    | "same_tenant"
    | "missing_claim"
    | "missing_check_tenant"
    | "cross_tenant"
    | "conflicting_claim_tenants";
  claimTenantIds: string[];
};

export const CHECK_CLAIM_LINK_DENIED = "check_claim_link_denied";

export function collectClaimTenantIds(
  signals: ClaimTenantSignal[] = [],
  excludeCheckId?: string | null,
): string[] {
  const tenants = new Set<string>();
  for (const signal of signals) {
    if (!signal?.tenantId) continue;
    if (excludeCheckId && signal.checkId && String(signal.checkId) === String(excludeCheckId)) {
      continue;
    }
    tenants.add(String(signal.tenantId));
  }
  return [...tenants];
}

export function evaluateCheckClaimLink(opts: {
  checkTenantId?: string | null;
  claimId?: string | null;
  claimExists?: boolean;
  claimTenantIds?: string[];
  signals?: ClaimTenantSignal[];
  excludeCheckId?: string | null;
}): CheckClaimLinkDecision {
  if (opts.claimId == null || opts.claimId === "") {
    return { allowed: true, reason: "unlinked", claimTenantIds: [] };
  }
  if (opts.claimExists === false) {
    return { allowed: false, reason: "missing_claim", claimTenantIds: [] };
  }

  const claimTenantIds = opts.claimTenantIds
    ?? collectClaimTenantIds(opts.signals ?? [], opts.excludeCheckId);

  if (!opts.checkTenantId) {
    return { allowed: false, reason: "missing_check_tenant", claimTenantIds };
  }
  if (claimTenantIds.length === 0) {
    return { allowed: true, reason: "first_link", claimTenantIds };
  }
  if (claimTenantIds.length > 1) {
    return { allowed: false, reason: "conflicting_claim_tenants", claimTenantIds };
  }
  if (String(claimTenantIds[0]) !== String(opts.checkTenantId)) {
    return { allowed: false, reason: "cross_tenant", claimTenantIds };
  }
  return { allowed: true, reason: "same_tenant", claimTenantIds };
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
  const message = String(error?.message || "");
  return message.includes(CHECK_CLAIM_LINK_DENIED);
}

export function checkClaimLinkUserMessage(reason: CheckClaimLinkDecision["reason"] | string) {
  switch (reason) {
    case "cross_tenant":
    case "conflicting_claim_tenants":
      return "This claim belongs to another tenant. The check was not linked.";
    case "missing_claim":
      return "That claim does not exist. The check was not linked.";
    case "missing_check_tenant":
      return "This check has no tenant, so it cannot be linked to a claim.";
    default:
      return "The claim link was rejected. The check was not changed.";
  }
}

type SignalClient = {
  from: (table: string) => any;
};

export async function loadClaimTenantSignals(
  supabase: SignalClient,
  claimId: string,
) {
  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, org_id")
    .eq("id", claimId)
    .maybeSingle();
  if (claimErr) throw claimErr;

  const { data: intakes } = await supabase
    .from("check_intake_items")
    .select("id, tenant_id")
    .eq("claim_id", claimId);
  const { data: checkCases } = await supabase
    .from("check_cases")
    .select("tenant_id")
    .eq("external_claim_id", claimId);
  const { data: ledgerEvents } = await supabase
    .from("homeowner_ledger_events")
    .select("tenant_id, check_id")
    .eq("claim_id", claimId);

  return signalsFromClaimRows({
    claim,
    intakes,
    checkCases,
    ledgerEvents,
  });
}

export function signalsFromClaimRows(opts: {
  claim?: { id?: string | null; org_id?: string | null } | null;
  intakes?: Array<{ id?: string | null; tenant_id?: string | null }> | null;
  checkCases?: Array<{ tenant_id?: string | null }> | null;
  ledgerEvents?: Array<{ tenant_id?: string | null; check_id?: string | null }> | null;
  claimChecks?: Array<{ check_intake_item_id?: string | null; tenant_id?: string | null }> | null;
  claimPayments?: Array<{ check_intake_item_id?: string | null; tenant_id?: string | null }> | null;
}): { claimExists: boolean; signals: ClaimTenantSignal[] } {
  const signals: ClaimTenantSignal[] = [];
  if (opts.claim?.org_id) {
    signals.push({ source: "org_id", tenantId: opts.claim.org_id });
  }
  for (const row of opts.intakes ?? []) {
    if (row.tenant_id) signals.push({ source: "intake", tenantId: row.tenant_id, checkId: row.id ?? null });
  }
  for (const row of opts.checkCases ?? []) {
    if (row.tenant_id) signals.push({ source: "check_case", tenantId: row.tenant_id });
  }
  for (const row of opts.ledgerEvents ?? []) {
    if (row.tenant_id) {
      signals.push({ source: "ledger_event", tenantId: row.tenant_id, checkId: row.check_id ?? null });
    }
  }
  for (const row of opts.claimChecks ?? []) {
    if (row.tenant_id) {
      signals.push({ source: "claim_check", tenantId: row.tenant_id, checkId: row.check_intake_item_id ?? null });
    }
  }
  for (const row of opts.claimPayments ?? []) {
    if (row.tenant_id) {
      signals.push({ source: "claim_payment", tenantId: row.tenant_id, checkId: row.check_intake_item_id ?? null });
    }
  }
  return { claimExists: Boolean(opts.claim?.id), signals };
}
