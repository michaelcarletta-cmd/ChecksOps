/** Catalog-definition guard for idx_claim_payments_check_intake. Name existence is not proof. */

export const REQUIRED_CLAIM_PAYMENTS_INDEX_NAME = "idx_claim_payments_check_intake";

export type CatalogIndex = {
  schemaname?: string | null;
  indexname: string;
  tablename?: string | null;
  indexdef: string;
};

export type DuplicatePaymentGroup = {
  check_intake_item_id: string;
  count: number;
};

export type ClaimPaymentIndexDecision = {
  ok: boolean;
  action: "pass" | "create" | "stop";
  reason: string;
  indexdef?: string | null;
  duplicateGroups: number;
};

export function normalizeIndexDef(indexdef?: string | null) {
  return String(indexdef || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function claimPaymentsIndexMatchesInvariant(indexdef?: string | null) {
  const normalized = normalizeIndexDef(indexdef);
  if (!normalized) return false;
  if (!normalized.includes("unique")) return false;
  if (!/\bon (?:public\.)?claim_payments\b/.test(normalized)) return false;

  const columnMatch = normalized.match(
    /\bon (?:public\.)?claim_payments(?: using [\w.]+)?\s*\(([^)]+)\)/,
  );
  if (!columnMatch) return false;
  const columns = columnMatch[1].split(",").map((part) => part.trim()).filter(Boolean);
  if (columns.length !== 1 || columns[0] !== "check_intake_item_id") return false;

  const whereMatch = normalized.match(/\bwhere\s+(.+)$/);
  if (!whereMatch) return false;
  const predicate = whereMatch[1].replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return predicate === "check_intake_item_id is not null";
}

export function verifyClaimPaymentsCheckIntakeIndex(opts: {
  indexes?: CatalogIndex[];
  duplicateGroups?: DuplicatePaymentGroup[] | number;
}) {
  const duplicateGroups = Array.isArray(opts.duplicateGroups)
    ? opts.duplicateGroups.length
    : Number(opts.duplicateGroups || 0);
  const named = (opts.indexes ?? []).find((index) => (
    index.indexname === REQUIRED_CLAIM_PAYMENTS_INDEX_NAME
    && (!index.schemaname || index.schemaname === "public")
  ));

  if (duplicateGroups > 0) {
    return {
      ok: false,
      action: "stop",
      reason: "duplicate_claim_payments",
      indexdef: named?.indexdef ?? null,
      duplicateGroups,
    } satisfies ClaimPaymentIndexDecision;
  }

  if (!named) {
    return {
      ok: true,
      action: "create",
      reason: "missing_index",
      indexdef: null,
      duplicateGroups,
    } satisfies ClaimPaymentIndexDecision;
  }

  if (!claimPaymentsIndexMatchesInvariant(named.indexdef)) {
    return {
      ok: false,
      action: "stop",
      reason: "index_definition_mismatch",
      indexdef: named.indexdef,
      duplicateGroups,
    } satisfies ClaimPaymentIndexDecision;
  }

  return {
    ok: true,
    action: "pass",
    reason: "definition_matches",
    indexdef: named.indexdef,
    duplicateGroups,
  } satisfies ClaimPaymentIndexDecision;
}

export function assertClaimPaymentsCheckIntakeIndex(opts: Parameters<typeof verifyClaimPaymentsCheckIntakeIndex>[0]) {
  const decision = verifyClaimPaymentsCheckIntakeIndex(opts);
  if (decision.action === "stop") {
    throw new Error(`claim_payments_index_guard: ${decision.reason}; stop before apply — no data deleted`);
  }
  return decision;
}
