import {
  collectClaimTenantIds,
  evaluateCheckClaimLink,
  type ClaimTenantSignal,
} from "./checkClaimOwnership.ts";

export type BackfillCheck = {
  id: string;
  claim_id?: string | null;
  tenant_id?: string | null;
  amount?: number | null;
  check_number?: string | null;
  carrier_name?: string | null;
  issue_date?: string | null;
  payee_line?: string | null;
  created_at?: string | null;
  status?: string | null;
};

export type BackfillClaimCheck = {
  id: string;
  claim_id: string;
  check_intake_item_id?: string | null;
};

export type BackfillPayment = {
  id: string;
  claim_id: string;
  check_intake_item_id?: string | null;
  amount?: number | null;
  notes?: string | null;
  check_number?: string | null;
};

export type BackfillEvent = {
  id?: string;
  check_id?: string | null;
  claim_id?: string | null;
  event_type: string;
  tenant_id?: string | null;
};

export type BackfillStore = {
  checks: BackfillCheck[];
  claims: Array<{ id: string; org_id?: string | null }>;
  claim_checks: BackfillClaimCheck[];
  claim_payments: BackfillPayment[];
  homeowner_ledger_events: BackfillEvent[];
  check_cases?: Array<{ external_claim_id?: string | null; tenant_id?: string | null }>;
};

export type BackfillInspectReport = {
  eligibleLinkedChecks: number;
  missingClaimChecks: string[];
  missingClaimPayments: string[];
  missingCheckReceived: string[];
  mismatchedClaimIds: Array<{ checkId: string; table: "claim_checks" | "claim_payments"; existingClaimId: string; expectedClaimId: string }>;
  crossTenantAnomalies: Array<{ checkId: string; reason: string; claimTenantIds: string[] }>;
  duplicatePaymentIdentities: Array<{ check_intake_item_id: string; count: number }>;
  duplicateCheckReceivedIdentities: Array<{ check_id: string; count: number }>;
  writes: number;
};

function signalsForClaim(store: BackfillStore, claimId: string): ClaimTenantSignal[] {
  const claim = store.claims.find((row) => row.id === claimId);
  const signals: ClaimTenantSignal[] = [];
  if (claim?.org_id) signals.push({ source: "org_id", tenantId: claim.org_id });
  for (const row of store.checks) {
    if (row.claim_id === claimId && row.tenant_id) {
      signals.push({ source: "intake", tenantId: row.tenant_id, checkId: row.id });
    }
  }
  for (const row of store.check_cases ?? []) {
    if (row.external_claim_id === claimId && row.tenant_id) {
      signals.push({ source: "check_case", tenantId: row.tenant_id });
    }
  }
  for (const row of store.homeowner_ledger_events) {
    if (row.claim_id === claimId && row.tenant_id) {
      signals.push({ source: "ledger_event", tenantId: row.tenant_id, checkId: row.check_id ?? null });
    }
  }
  for (const row of store.claim_checks) {
    if (row.claim_id !== claimId || !row.check_intake_item_id) continue;
    const intake = store.checks.find((check) => check.id === row.check_intake_item_id);
    if (intake?.tenant_id) {
      signals.push({ source: "claim_check", tenantId: intake.tenant_id, checkId: intake.id });
    }
  }
  for (const row of store.claim_payments) {
    if (row.claim_id !== claimId || !row.check_intake_item_id) continue;
    const intake = store.checks.find((check) => check.id === row.check_intake_item_id);
    if (intake?.tenant_id) {
      signals.push({ source: "claim_payment", tenantId: intake.tenant_id, checkId: intake.id });
    }
  }
  return signals;
}

export function inspectLedgerBackfill(store: BackfillStore): BackfillInspectReport {
  const eligible = store.checks.filter((check) => check.claim_id);
  const missingClaimChecks: string[] = [];
  const missingClaimPayments: string[] = [];
  const missingCheckReceived: string[] = [];
  const mismatchedClaimIds: BackfillInspectReport["mismatchedClaimIds"] = [];
  const crossTenantAnomalies: BackfillInspectReport["crossTenantAnomalies"] = [];

  for (const check of eligible) {
    const claimExists = store.claims.some((claim) => claim.id === check.claim_id);
    const decision = evaluateCheckClaimLink({
      checkTenantId: check.tenant_id,
      claimId: check.claim_id,
      claimExists,
      signals: signalsForClaim(store, String(check.claim_id)),
      excludeCheckId: check.id,
    });
    if (!decision.allowed) {
      crossTenantAnomalies.push({
        checkId: check.id,
        reason: decision.reason,
        claimTenantIds: decision.claimTenantIds,
      });
    }

    const claimChecks = store.claim_checks.filter((row) => row.check_intake_item_id === check.id);
    if (!claimChecks.length) missingClaimChecks.push(check.id);
    for (const row of claimChecks) {
      if (row.claim_id !== check.claim_id) {
        mismatchedClaimIds.push({
          checkId: check.id,
          table: "claim_checks",
          existingClaimId: row.claim_id,
          expectedClaimId: String(check.claim_id),
        });
      }
    }

    if (check.amount != null) {
      const payments = store.claim_payments.filter((row) => row.check_intake_item_id === check.id);
      if (!payments.length) missingClaimPayments.push(check.id);
      for (const row of payments) {
        if (row.claim_id !== check.claim_id) {
          mismatchedClaimIds.push({
            checkId: check.id,
            table: "claim_payments",
            existingClaimId: row.claim_id,
            expectedClaimId: String(check.claim_id),
          });
        }
      }
    }

    const received = store.homeowner_ledger_events.filter((row) => (
      row.check_id === check.id && row.event_type === "check_received"
    ));
    if (!received.length) missingCheckReceived.push(check.id);
  }

  const paymentCounts = new Map<string, number>();
  for (const row of store.claim_payments) {
    if (!row.check_intake_item_id) continue;
    paymentCounts.set(row.check_intake_item_id, (paymentCounts.get(row.check_intake_item_id) || 0) + 1);
  }
  const receivedCounts = new Map<string, number>();
  for (const row of store.homeowner_ledger_events) {
    if (row.event_type !== "check_received" || !row.check_id) continue;
    receivedCounts.set(row.check_id, (receivedCounts.get(row.check_id) || 0) + 1);
  }

  return {
    eligibleLinkedChecks: eligible.length,
    missingClaimChecks,
    missingClaimPayments,
    missingCheckReceived,
    mismatchedClaimIds,
    crossTenantAnomalies,
    duplicatePaymentIdentities: [...paymentCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([check_intake_item_id, count]) => ({ check_intake_item_id, count })),
    duplicateCheckReceivedIdentities: [...receivedCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([check_id, count]) => ({ check_id, count })),
    writes: 0,
  };
}

export function applyLedgerBackfill(store: BackfillStore) {
  const report = inspectLedgerBackfill(store);
  if (report.crossTenantAnomalies.length) {
    throw new Error(`ledger_backfill_stop: cross_tenant_anomaly (${report.crossTenantAnomalies.length})`);
  }
  if (report.duplicatePaymentIdentities.length) {
    throw new Error("ledger_backfill_stop: duplicate_claim_payments");
  }
  if (report.duplicateCheckReceivedIdentities.length) {
    throw new Error("ledger_backfill_stop: duplicate_check_received");
  }

  let writes = 0;
  const eligible = store.checks.filter((check) => check.claim_id);

  for (const check of eligible) {
    const existingCc = store.claim_checks.filter((row) => row.check_intake_item_id === check.id);
    if (!existingCc.length) {
      store.claim_checks.push({
        id: `cc-${check.id}`,
        claim_id: String(check.claim_id),
        check_intake_item_id: check.id,
      });
      writes += 1;
    } else if (existingCc[0].claim_id !== check.claim_id) {
      existingCc[0].claim_id = String(check.claim_id);
      writes += 1;
    }

    if (check.amount != null) {
      const existingPay = store.claim_payments.filter((row) => row.check_intake_item_id === check.id);
      if (!existingPay.length) {
        store.claim_payments.push({
          id: `pay-${check.id}`,
          claim_id: String(check.claim_id),
          check_intake_item_id: check.id,
          amount: check.amount,
          check_number: check.check_number ?? null,
          notes: `Insurance check from ${check.carrier_name ?? "Unknown carrier"}`,
        });
        writes += 1;
      } else if (existingPay[0].claim_id !== check.claim_id) {
        existingPay[0].claim_id = String(check.claim_id);
        writes += 1;
      }
    }

    const received = store.homeowner_ledger_events.filter((row) => (
      row.check_id === check.id && row.event_type === "check_received"
    ));
    if (!received.length) {
      store.homeowner_ledger_events.push({
        id: `evt-${check.id}`,
        tenant_id: check.tenant_id ?? null,
        claim_id: check.claim_id,
        check_id: check.id,
        event_type: "check_received",
      });
      writes += 1;
    }
  }

  return { ...inspectLedgerBackfill(store), writes };
}

export function claimObservedTenantIds(store: BackfillStore, claimId: string, excludeCheckId?: string | null) {
  return collectClaimTenantIds(signalsForClaim(store, claimId), excludeCheckId);
}
