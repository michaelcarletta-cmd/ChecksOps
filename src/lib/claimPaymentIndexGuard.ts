/** Catalog-shape guard for idx_claim_payments_check_intake. indexdef text is not proof. */

export const REQUIRED_CLAIM_PAYMENTS_INDEX_NAME = "idx_claim_payments_check_intake";

export type CatalogIndexShape = {
  indexname: string;
  nspname?: string | null;
  relname?: string | null;
  indisunique?: boolean | null;
  columns?: string[] | null;
  indpred?: string | null;
};

export type DuplicatePaymentGroup = {
  check_intake_item_id: string;
  count: number;
};

export type ClaimPaymentIndexDecision = {
  ok: boolean;
  action: "pass" | "create" | "stop";
  reason: string;
  duplicateGroups: number;
};

export function claimPaymentsIndexCatalogMatches(index?: CatalogIndexShape | null) {
  if (!index) return false;
  if (!index.indisunique) return false;
  if (String(index.relname || "") !== "claim_payments") return false;
  if (String(index.nspname || "public") !== "public") return false;
  const columns = index.columns ?? [];
  if (columns.length !== 1 || columns[0] !== "check_intake_item_id") return false;
  const predicate = String(index.indpred || "").toLowerCase().replace(/[() ]+/g, " ").trim();
  return predicate === "check_intake_item_id is not null";
}

export function verifyClaimPaymentsCheckIntakeIndex(opts: {
  indexes?: CatalogIndexShape[];
  duplicateGroups?: DuplicatePaymentGroup[] | number;
}) {
  const duplicateGroups = Array.isArray(opts.duplicateGroups)
    ? opts.duplicateGroups.length
    : Number(opts.duplicateGroups || 0);
  const named = (opts.indexes ?? []).find((index) => (
    index.indexname === REQUIRED_CLAIM_PAYMENTS_INDEX_NAME
    && (!index.nspname || index.nspname === "public")
  ));

  if (duplicateGroups > 0) {
    return { ok: false, action: "stop" as const, reason: "duplicate_claim_payments", duplicateGroups };
  }
  if (!named) {
    return { ok: true, action: "create" as const, reason: "missing_index", duplicateGroups };
  }
  if (!claimPaymentsIndexCatalogMatches(named)) {
    return { ok: false, action: "stop" as const, reason: "index_catalog_mismatch", duplicateGroups };
  }
  return { ok: true, action: "pass" as const, reason: "catalog_matches", duplicateGroups };
}

export function assertClaimPaymentsCheckIntakeIndex(opts: Parameters<typeof verifyClaimPaymentsCheckIntakeIndex>[0]) {
  const decision = verifyClaimPaymentsCheckIntakeIndex(opts);
  if (decision.action === "stop") {
    throw new Error(`claim_payments_index_guard: ${decision.reason}; stop before apply — no data deleted`);
  }
  return decision;
}
