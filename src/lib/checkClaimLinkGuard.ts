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

export type ClaimLedgerInspectResult = {
  ok?: boolean;
  code?: string | null;
  can_create?: boolean;
  can_link?: boolean;
  claim_id?: string | null;
  claim_number?: string | null;
  policyholder_name?: string | null;
  same_tenant_detected_count?: number;
  same_tenant_unlinked_count?: number;
  same_tenant_already_linked_count?: number;
  associated_check_count?: number;
  linked_check_count?: number;
  already_linked_sibling_count?: number;
};

export type ClaimLedgerDiscoverySummary = {
  kind: "not_found" | "ocr_group";
  headline: string;
  lines: string[];
};

function asCount(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Inspect no_match copy. OCR candidates are discovery evidence, not ownership. */
export function claimLedgerDiscoverySummary(
  result: ClaimLedgerInspectResult | null | undefined,
): ClaimLedgerDiscoverySummary | null {
  if (!result || result.code !== "no_match") return null;
  const detected = asCount(result.same_tenant_detected_count);
  const unlinked = asCount(result.same_tenant_unlinked_count);
  const already = asCount(result.same_tenant_already_linked_count);
  const claimNumber = String(result.claim_number || "").trim();
  if (detected <= 0 && unlinked <= 0) {
    return {
      kind: "not_found",
      headline: "No existing claim with that number in this tenant.",
      lines: [],
    };
  }
  const checkCount = detected > 0 ? detected : unlinked;
  const lines = [
    checkCount === 1
      ? "1 check found for this claim number."
      : `${checkCount} checks found for this claim number.`,
    "No Claim Ledger has been created yet.",
  ];
  if (already > 0) {
    lines.push(
      already === 1
        ? "1 already-linked check stays on its current ledger."
        : `${already} already-linked checks stay on their current ledgers.`,
    );
  }
  return {
    kind: "ocr_group",
    headline: claimNumber ? `Claim #${claimNumber}` : "Claim number",
    lines,
  };
}

export function claimLedgerCreatedSummary(
  result: ClaimLedgerInspectResult | null | undefined,
) {
  const associated = asCount(result?.associated_check_count) || asCount(result?.linked_check_count);
  const skipped = asCount(result?.already_linked_sibling_count);
  const claimNumber = String(result?.claim_number || "").trim();
  const lines = ["Claim Ledger created."];
  if (associated > 0) {
    lines.push(
      associated === 1
        ? "1 check associated with this claim."
        : `${associated} checks associated with this claim.`,
    );
  }
  if (skipped > 0) {
    lines.push(
      skipped === 1
        ? "1 already-linked check was left unchanged."
        : `${skipped} already-linked checks were left unchanged.`,
    );
  }
  return {
    headline: claimNumber ? `Claim #${claimNumber}` : "Claim Ledger",
    lines,
  };
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

/* ------------------------------------------------------------------ */
/*  Claim number correction on a linked check (SQL 167, AWS backend)   */
/* ------------------------------------------------------------------ */
// Owner 2026-11-14: "Need to be able to change/correct claim number once edited for ledger to link to existing
// claim". On the AWS backend a linked check's Save first asks claim_ledger_relink_check (inspect): when a claim of
// this tenant already has the corrected number, the check moves to it (relink), with its loss draft and signature
// requests, only before deposit; when no claim has it, the current claim is renamed as before (update_existing).
// The tenant and the actor come from the signed-in user on the server; the body carries neither.

export const CLAIM_LEDGER_RELINK_RPC = "claim_ledger_relink_check";

export type ClaimLedgerRelinkAction = "inspect" | "relink";

export type LinkedClaimNumberSavePlan =
  | { mode: "relink_inspect"; claimId: string; claimNumber: string }
  | Extract<ClaimNumberSavePlan, { mode: "update_existing" }>;

/**
 * Linked check Save. AWS backend: inspect first (relink_inspect). Legacy backend: today's in-place rename
 * (update_existing). An unlinked check never reaches here (Find Existing Claim / Start New Claim Ledger).
 */
export function planLinkedClaimNumberSave(opts: {
  awsBackend: boolean;
  existingClaimId?: string | null;
  claimNumber: string;
}): LinkedClaimNumberSavePlan {
  const plan = planClaimNumberSave({ existingClaimId: opts.existingClaimId, claimNumber: opts.claimNumber });
  if (plan.mode !== "update_existing") {
    throw new Error(CLAIM_LEDGER_NOT_LINKED);
  }
  if (opts.awsBackend) {
    return { mode: "relink_inspect", claimId: plan.claimId, claimNumber: plan.claimNumber };
  }
  return plan;
}

export function claimLedgerRelinkArgs(opts: {
  checkId: string;
  claimNumber: string;
  action: ClaimLedgerRelinkAction;
}) {
  const claimNumber = String(opts.claimNumber || "").trim();
  if (!claimNumber) {
    throw new Error("Enter a claim number");
  }
  if (!opts.checkId) {
    throw new Error("Missing check");
  }
  if (opts.action !== "inspect" && opts.action !== "relink") {
    throw new Error("Invalid claim number action");
  }
  return {
    p_check_id: String(opts.checkId),
    p_claim_number: claimNumber,
    p_action: opts.action,
  };
}

export type ClaimLedgerRelinkResult = {
  ok?: boolean;
  persisted?: boolean;
  code?: string | null;
  can_relink?: boolean;
  claim_id?: string | null;
  claim_number?: string | null;
  policyholder_name?: string | null;
  check_claim_id?: string | null;
  old_claim_id?: string | null;
  old_claim_number?: string | null;
  old_claim_other_check_count?: number;
  old_claim_remaining_check_count?: number;
  old_claim_has_settlements?: boolean;
  loss_draft_rows_to_move?: number;
  signature_request_rows_to_move?: number;
  loss_draft_rows_moved?: number;
  signature_request_rows_moved?: number;
};

export type ClaimLedgerRelinkNext =
  | { kind: "confirm_move"; result: ClaimLedgerRelinkResult }
  | { kind: "rename" }
  | { kind: "unchanged"; claimNumber: string };

/** What the card does after inspect. Refusals arrive as errors (the API answers them 4xx). */
export function claimLedgerRelinkNext(result: ClaimLedgerRelinkResult | null | undefined): ClaimLedgerRelinkNext {
  const code = result?.code;
  if (code === "relink_available" && result?.can_relink !== false && result?.claim_id) {
    return { kind: "confirm_move", result: result as ClaimLedgerRelinkResult };
  }
  if (code === "no_match") return { kind: "rename" };
  if (code === "unchanged") return { kind: "unchanged", claimNumber: String(result?.claim_number || "").trim() };
  throw new Error(claimLedgerRelinkUserMessage(code));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/** The confirm shown before a move: the target claim, then what changes on the old one. */
export function claimLedgerRelinkConfirmCopy(result: ClaimLedgerRelinkResult) {
  const target = String(result.claim_number || "").trim();
  const oldNumber = String(result.old_claim_number || "").trim();
  const oldLabel = oldNumber ? `claim #${oldNumber}` : "the current claim";
  const others = asCount(result.old_claim_other_check_count);
  const lossDrafts = asCount(result.loss_draft_rows_to_move);
  const signatures = asCount(result.signature_request_rows_to_move);
  const lines: string[] = [];
  if (result.policyholder_name) lines.push(`Claim #${target} is ${String(result.policyholder_name).trim()}'s claim.`);
  lines.push(others > 0
    ? plural(others, `1 other check stays on ${oldLabel}.`, `{n} other checks stay on ${oldLabel}.`)
    : `No other check is on ${oldLabel}; it will have no checks left.`);
  if (result.old_claim_has_settlements) {
    lines.push(`The settlement amounts entered on ${oldLabel} stay on it.`);
  }
  lines.push(lossDrafts > 0
    ? plural(lossDrafts, "1 loss draft file moves with this check.", "{n} loss draft files move with this check.")
    : "This check has no loss draft file to move.");
  lines.push(signatures > 0
    ? plural(signatures, "1 signature request moves with this check.", "{n} signature requests move with this check.")
    : "This check has no signature requests to move.");
  lines.push("Only checks that are not deposited can move.");
  return {
    title: `Claim #${target} exists — move this check (and its loss draft and signature requests) to it?`,
    lines,
    confirmLabel: `Move to claim #${target}`,
  };
}

/** Toast after a move; old_claim_remaining_check_count is the old claim's checks left behind. */
export function claimLedgerRelinkedToast(result: ClaimLedgerRelinkResult) {
  const target = String(result.claim_number || "").trim();
  const oldNumber = String(result.old_claim_number || "").trim();
  const oldLabel = oldNumber ? `Claim #${oldNumber}` : "The previous claim";
  const remaining = asCount(result.old_claim_remaining_check_count);
  return {
    title: `Check moved to claim #${target}`,
    description: remaining > 0
      ? `${oldLabel} still has ${plural(remaining, "1 check", "{n} checks")}.`
      : `${oldLabel} has no checks left.`,
  };
}

/** No claim has the corrected number: the current claim is renamed (today's Save). Warn when other checks share it. */
export function claimLedgerRenameWarning(opts: {
  otherCheckCount: number;
  currentClaimNumber?: string | null;
  newClaimNumber: string;
}) {
  const others = asCount(opts.otherCheckCount);
  if (others <= 0) return null;
  const current = String(opts.currentClaimNumber || "").trim();
  const next = String(opts.newClaimNumber || "").trim();
  return {
    title: `No claim has #${next}. Rename claim${current ? ` #${current}` : ""} instead?`,
    lines: [
      plural(others, "1 other check shares this claim and will show the new number too.", "{n} other checks share this claim and will show the new number too."),
    ],
    confirmLabel: `Rename claim to #${next}`,
  };
}

export function claimLedgerRelinkUserMessage(code: string | null | undefined) {
  switch (code) {
    case "locked":
      return "This check is deposited (or voided or returned), so its claim can no longer be changed.";
    case "ambiguous":
      return "More than one claim has this number. The check was not moved.";
    case "cross_tenant":
      return "That claim number belongs to another company. The check was not moved.";
    case "not_linked":
      return "This check is not linked to a claim yet. Use Find Existing Claim to link it.";
    case "no_match":
      return "No claim has that number any more. The check was not moved.";
    case "check_not_found":
    case "tenant_mismatch":
      return "This check was not found or is not writable.";
    case "invalid_args":
    case "invalid_field":
    case "missing_required_field":
      return "Enter a claim number.";
    case "claim_ledger_relink_failed":
      return "The check changed while it was being moved. Nothing was moved; refresh and try again.";
    case "claim_ledger_relink_unavailable":
      return "Moving a check to another claim is not available yet.";
    default:
      return "The claim number change was rejected. The check was not changed.";
  }
}
