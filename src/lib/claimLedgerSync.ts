/** Pure plan and idempotent apply for one-check → one-claim ledger sync. No junction table. */

import {
  evaluateCheckClaimLink,
  type CheckClaimLinkDecision,
  type ClaimTenantSignal,
} from "./checkClaimOwnership.ts";

export type IntakeCheck = {
  id: string;
  claim_id?: string | null;
  amount?: number | null;
  check_number?: string | null;
  carrier_name?: string | null;
  issue_date?: string | null;
  payee_line?: string | null;
  tenant_id?: string | null;
  status?: string | null;
};

export type LedgerEvent = {
  check_id: string;
  claim_id?: string | null;
  event_type: string;
  tenant_id?: string | null;
};

export type ExistingLedgerRow = {
  id: string;
  claim_id?: string | null;
  created_at?: string | null;
};

export function selectCanonicalRow(rows: ExistingLedgerRow[] = []): {
  id: string | null;
  duplicate: boolean;
  extraIds: string[];
} {
  const sorted = [...rows].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  if (!sorted.length) return { id: null, duplicate: false, extraIds: [] };
  return {
    id: sorted[0].id,
    duplicate: sorted.length > 1,
    extraIds: sorted.slice(1).map((row) => row.id),
  };
}

export function isDownstreamConsistent(opts: {
  check: IntakeCheck;
  newClaimId: string;
  existingClaimCheck?: ExistingLedgerRow | null;
  existingPayment?: ExistingLedgerRow | null;
  existingEvents?: LedgerEvent[];
}) {
  const { check, newClaimId, existingClaimCheck, existingPayment, existingEvents = [] } = opts;
  if (check.claim_id !== newClaimId) return false;
  if (!existingClaimCheck?.id || existingClaimCheck.claim_id !== newClaimId) return false;
  if (check.amount != null && (!existingPayment?.id || existingPayment.claim_id !== newClaimId)) return false;
  const received = existingEvents.some((event) => event.event_type === "check_received" && event.check_id === check.id);
  if (!received) return false;
  return !existingEvents.some((event) => (
    event.check_id === check.id && event.claim_id && event.claim_id !== newClaimId
  ));
}

export function buildClaimLedgerSyncPlan(opts: {
  check: IntakeCheck;
  newClaimId: string;
  claimNumber: string;
  existingPaymentId?: string | null;
  existingClaimCheckId?: string | null;
  existingEvents?: LedgerEvent[];
  existingClaimCheck?: ExistingLedgerRow | null;
  existingPayment?: ExistingLedgerRow | null;
  actorTenantId?: string | null;
  claimExists?: boolean;
  claimTenantIds?: string[];
  claimTenantSignals?: ClaimTenantSignal[];
}) {
  const { check, newClaimId, claimNumber, existingEvents = [] } = opts;
  if (opts.actorTenantId && check.tenant_id && String(opts.actorTenantId) !== String(check.tenant_id)) {
    return {
      denied: true as const,
      reason: "cross_tenant",
      sameClaim: false,
      skipWrites: true,
      insertCheckReceived: false,
    };
  }

  const ownership: CheckClaimLinkDecision = evaluateCheckClaimLink({
    checkTenantId: check.tenant_id,
    claimId: newClaimId,
    claimExists: opts.claimExists,
    claimTenantIds: opts.claimTenantIds,
    signals: opts.claimTenantSignals,
    excludeCheckId: check.id,
  });
  if (!ownership.allowed) {
    return {
      denied: true as const,
      reason: ownership.reason,
      sameClaim: false,
      skipWrites: true,
      insertCheckReceived: false,
    };
  }

  const existingClaimCheck = opts.existingClaimCheck || (opts.existingClaimCheckId
    ? { id: opts.existingClaimCheckId, claim_id: check.claim_id }
    : null);
  const existingPayment = opts.existingPayment || (opts.existingPaymentId
    ? { id: opts.existingPaymentId, claim_id: check.claim_id }
    : null);
  const consistent = isDownstreamConsistent({
    check,
    newClaimId,
    existingClaimCheck,
    existingPayment,
    existingEvents,
  });
  const sameClaim = check.claim_id === newClaimId && Boolean(existingClaimCheck?.id);
  const checkReceived = existingEvents.some((event) => event.event_type === "check_received" && event.check_id === check.id);

  return {
    denied: false as const,
    skipWrites: consistent,
    sameClaim,
    intake: {
      id: check.id,
      claim_id: newClaimId,
      detected_claim_number: claimNumber,
    },
    claimChecks: {
      op: existingClaimCheck?.id ? "update" as const : "insert" as const,
      id: existingClaimCheck?.id ?? null,
      values: {
        claim_id: newClaimId,
        check_intake_item_id: check.id,
        check_number: check.check_number || `OCR-${check.id}`,
        amount: check.amount ?? null,
        carrier_name: check.carrier_name ?? null,
        check_date: check.issue_date ?? null,
        payee_line: check.payee_line ?? null,
        source: "uploaded_check_ocr",
        check_type: "insurance_check",
      },
    },
    claimPayments: check.amount == null
      ? { op: "skip" as const }
      : {
          op: existingPayment?.id ? "update" as const : "insert" as const,
          id: existingPayment?.id ?? null,
          values: {
            claim_id: newClaimId,
            check_intake_item_id: check.id,
            amount: Number(check.amount),
            payment_method: "insurance_check",
            payment_date: check.issue_date || new Date().toISOString().slice(0, 10),
            recipient_type: "insured",
            direction: "inbound",
            check_number: check.check_number ?? null,
            notes: `Insurance check from ${check.carrier_name ?? "Unknown carrier"}`,
          },
        },
    moveLedgerEvents: {
      check_id: check.id,
      claim_id: newClaimId,
      tenant_id: check.tenant_id ?? null,
    },
    insertCheckReceived: !checkReceived,
  };
}

export function fundsReceivedForClaim(checks: Array<{ id: string; claim_id?: string | null; amount?: number | null }>, claimId: string) {
  const seen = new Set<string>();
  let total = 0;
  for (const check of checks) {
    if (check.claim_id !== claimId) continue;
    if (seen.has(check.id)) continue;
    seen.add(check.id);
    total += Number(check.amount || 0);
  }
  return total;
}

type LedgerClient = {
  from: (table: string) => any;
};

export async function applyClaimLedgerSync(
  supabase: LedgerClient,
  opts: {
    check: IntakeCheck;
    newClaimId: string;
    claimNumber: string;
    actorTenantId?: string | null;
    claimExists?: boolean;
    claimTenantIds?: string[];
    claimTenantSignals?: ClaimTenantSignal[];
  },
) {
  const { check, newClaimId, claimNumber, actorTenantId } = opts;
  if (actorTenantId && check.tenant_id && String(actorTenantId) !== String(check.tenant_id)) {
    return { denied: true, reason: "cross_tenant", skipWrites: true };
  }
  const ownership = evaluateCheckClaimLink({
    checkTenantId: check.tenant_id,
    claimId: newClaimId,
    claimExists: opts.claimExists,
    claimTenantIds: opts.claimTenantIds,
    signals: opts.claimTenantSignals,
    excludeCheckId: check.id,
  });
  if (!ownership.allowed) {
    return { denied: true, reason: ownership.reason, skipWrites: true };
  }

  const { data: claimCheckRows } = await supabase
    .from("claim_checks")
    .select("id, claim_id, created_at")
    .eq("check_intake_item_id", check.id)
    .order("created_at", { ascending: true });
  const { data: paymentRows } = await supabase
    .from("claim_payments")
    .select("id, claim_id, created_at")
    .eq("check_intake_item_id", check.id)
    .order("created_at", { ascending: true });
  const eventsQuery = supabase
    .from("homeowner_ledger_events")
    .select("check_id, claim_id, event_type, tenant_id")
    .eq("check_id", check.id);
  const { data: events } = check.tenant_id
    ? await eventsQuery.eq("tenant_id", check.tenant_id)
    : await eventsQuery;

  const canonicalCheck = selectCanonicalRow(claimCheckRows ?? []);
  const canonicalPayment = selectCanonicalRow(paymentRows ?? []);
  const existingClaimCheck = (claimCheckRows ?? []).find((row: ExistingLedgerRow) => row.id === canonicalCheck.id) || null;
  const existingPayment = (paymentRows ?? []).find((row: ExistingLedgerRow) => row.id === canonicalPayment.id) || null;

  const plan = buildClaimLedgerSyncPlan({
    check,
    newClaimId,
    claimNumber,
    existingClaimCheck,
    existingPayment,
    existingEvents: events ?? [],
    actorTenantId,
    claimExists: opts.claimExists,
    claimTenantIds: opts.claimTenantIds,
    claimTenantSignals: opts.claimTenantSignals,
  });
  if (plan.denied || plan.skipWrites) return plan;

  if (plan.claimChecks.op === "insert") {
    const inserted = await supabase.from("claim_checks").insert(plan.claimChecks.values);
    if (inserted.error?.code === "23505") {
      await supabase
        .from("claim_checks")
        .update({
          claim_id: newClaimId,
          check_number: plan.claimChecks.values.check_number,
          amount: plan.claimChecks.values.amount,
          carrier_name: plan.claimChecks.values.carrier_name,
          check_date: plan.claimChecks.values.check_date,
          payee_line: plan.claimChecks.values.payee_line,
          updated_at: new Date().toISOString(),
        })
        .eq("check_intake_item_id", check.id);
    }
  } else if (plan.claimChecks.id) {
    await supabase
      .from("claim_checks")
      .update({
        claim_id: newClaimId,
        check_number: plan.claimChecks.values.check_number,
        amount: plan.claimChecks.values.amount,
        carrier_name: plan.claimChecks.values.carrier_name,
        check_date: plan.claimChecks.values.check_date,
        payee_line: plan.claimChecks.values.payee_line,
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.claimChecks.id)
      .eq("check_intake_item_id", check.id);
  }

  if (plan.claimPayments.op === "insert") {
    const inserted = await supabase.from("claim_payments").insert(plan.claimPayments.values);
    if (inserted.error?.code === "23505") {
      await supabase
        .from("claim_payments")
        .update({
          claim_id: newClaimId,
          amount: plan.claimPayments.values.amount,
          check_number: plan.claimPayments.values.check_number,
          notes: plan.claimPayments.values.notes,
          updated_at: new Date().toISOString(),
        })
        .eq("check_intake_item_id", check.id);
    }
  } else if (plan.claimPayments.op === "update" && plan.claimPayments.id) {
    await supabase
      .from("claim_payments")
      .update({
        claim_id: newClaimId,
        amount: plan.claimPayments.values.amount,
        check_number: plan.claimPayments.values.check_number,
        notes: plan.claimPayments.values.notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.claimPayments.id)
      .eq("check_intake_item_id", check.id);
  }

  let eventUpdate = supabase
    .from("homeowner_ledger_events")
    .update({ claim_id: newClaimId })
    .eq("check_id", check.id);
  if (check.tenant_id) eventUpdate = eventUpdate.eq("tenant_id", check.tenant_id);
  await eventUpdate;

  if (plan.insertCheckReceived && check.tenant_id) {
    await supabase.from("homeowner_ledger_events").insert({
      tenant_id: check.tenant_id,
      claim_id: newClaimId,
      check_id: check.id,
      event_type: "check_received",
      occurred_at: new Date().toISOString(),
      amount: check.amount ?? null,
      actor_label: "System",
      payload_json: { status: check.status, source: "claim_link_sync" },
    });
  }

  return { ...plan, duplicatePayments: canonicalPayment.duplicate, duplicateClaimChecks: canonicalCheck.duplicate };
}

export function insertCheckReceivedConflictSafe(
  events: Array<Record<string, any>>,
  row: Record<string, any>,
) {
  const existing = events.find((event) => (
    event.check_id === row.check_id && event.event_type === "check_received"
  ));
  if (existing) return { inserted: false, id: existing.id ?? null };
  events.push(row);
  return { inserted: true, id: row.id ?? null };
}

/** In-memory SQL-trigger semantics for double-execution tests. */
export function applyDatabaseLedgerSync(store: {
  claim_checks: Array<Record<string, any>>;
  claim_payments: Array<Record<string, any>>;
  homeowner_ledger_events: Array<Record<string, any>>;
  check_intake_items: Array<Record<string, any>>;
  claims?: Array<Record<string, any>>;
  check_cases?: Array<Record<string, any>>;
}, checkId: string) {
  const check = store.check_intake_items.find((row) => row.id === checkId);
  if (!check?.claim_id) return { skipped: true };
  if (store.claims || store.check_cases) {
    const claim = (store.claims ?? []).find((row) => row.id === check.claim_id);
    const ownership = evaluateCheckClaimLink({
      checkTenantId: check.tenant_id,
      claimId: check.claim_id,
      claimExists: Boolean(claim),
      signals: [
        ...(claim?.org_id ? [{ source: "org_id" as const, tenantId: String(claim.org_id) }] : []),
        ...(store.check_intake_items ?? [])
          .filter((row) => row.claim_id === check.claim_id && row.tenant_id)
          .map((row) => ({ source: "intake" as const, tenantId: String(row.tenant_id), checkId: row.id })),
        ...(store.check_cases ?? [])
          .filter((row) => row.external_claim_id === check.claim_id && row.tenant_id)
          .map((row) => ({ source: "check_case" as const, tenantId: String(row.tenant_id) })),
      ],
      excludeCheckId: check.id,
    });
    if (!ownership.allowed) {
      throw new Error(`check_claim_link_denied: ${ownership.reason}`);
    }
  }
  const paymentDate = check.issue_date || new Date().toISOString().slice(0, 10);

  const existingCc = store.claim_checks.filter((row) => row.check_intake_item_id === check.id);
  if (!existingCc.length) {
    store.claim_checks.push({
      id: `cc-${check.id}`,
      claim_id: check.claim_id,
      check_intake_item_id: check.id,
      amount: check.amount,
      check_number: check.check_number || `OCR-${check.id}`,
    });
  } else {
    existingCc[0].claim_id = check.claim_id;
    existingCc[0].amount = check.amount;
  }

  if (check.amount != null) {
    const existingPay = store.claim_payments.filter((row) => row.check_intake_item_id === check.id);
    if (!existingPay.length) {
      store.claim_payments.push({
        id: `pay-${check.id}`,
        claim_id: check.claim_id,
        check_intake_item_id: check.id,
        amount: check.amount,
        payment_method: "insurance_check",
        payment_date: paymentDate,
      });
    } else {
      existingPay[0].claim_id = check.claim_id;
      existingPay[0].amount = check.amount;
    }
  }

  for (const event of store.homeowner_ledger_events) {
    if (event.check_id === check.id && (!check.tenant_id || event.tenant_id === check.tenant_id)) {
      event.claim_id = check.claim_id;
    }
  }
  if (check.tenant_id) {
    insertCheckReceivedConflictSafe(store.homeowner_ledger_events, {
      id: `evt-${check.id}`,
      tenant_id: check.tenant_id,
      claim_id: check.claim_id,
      check_id: check.id,
      event_type: "check_received",
    });
  }
  return { skipped: false };
}
