/** Pure plan for one-check → one-claim ledger sync. No junction table. */

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
};

export function buildClaimLedgerSyncPlan(opts: {
  check: IntakeCheck;
  newClaimId: string;
  claimNumber: string;
  existingPaymentId?: string | null;
  existingClaimCheckId?: string | null;
  existingEvents?: LedgerEvent[];
}) {
  const { check, newClaimId, claimNumber, existingPaymentId, existingClaimCheckId, existingEvents = [] } = opts;
  const sameClaim = check.claim_id === newClaimId && Boolean(existingClaimCheckId);
  const checkReceived = existingEvents.some((e) => e.event_type === "check_received");

  return {
    sameClaim,
    intake: {
      id: check.id,
      claim_id: newClaimId,
      detected_claim_number: claimNumber,
    },
    claimChecks: {
      op: existingClaimCheckId ? "update" : "insert",
      id: existingClaimCheckId ?? null,
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
          op: existingPaymentId ? "update" as const : "insert" as const,
          id: existingPaymentId ?? null,
          values: {
            claim_id: newClaimId,
            check_intake_item_id: check.id,
            amount: Number(check.amount),
            payment_method: "insurance_check",
            payment_date: new Date().toISOString().slice(0, 10),
            recipient_type: "insured",
            direction: "inbound",
            check_number: check.check_number ?? null,
            notes: `Insurance check from ${check.carrier_name ?? "Unknown carrier"}`,
          },
        },
    moveLedgerEvents: {
      check_id: check.id,
      claim_id: newClaimId,
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
  opts: { check: IntakeCheck; newClaimId: string; claimNumber: string },
) {
  const { check, newClaimId, claimNumber } = opts;
  const { data: existingCc } = await supabase
    .from("claim_checks")
    .select("id")
    .eq("check_intake_item_id", check.id)
    .maybeSingle();
  const { data: existingPay } = await supabase
    .from("claim_payments")
    .select("id")
    .eq("check_intake_item_id", check.id)
    .maybeSingle();
  const { data: events } = await supabase
    .from("homeowner_ledger_events")
    .select("check_id, claim_id, event_type")
    .eq("check_id", check.id);

  const plan = buildClaimLedgerSyncPlan({
    check,
    newClaimId,
    claimNumber,
    existingPaymentId: existingPay?.id ?? null,
    existingClaimCheckId: existingCc?.id ?? null,
    existingEvents: events ?? [],
  });

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
  } else {
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
      .eq("id", plan.claimChecks.id);
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
  } else if (plan.claimPayments.op === "update") {
    await supabase
      .from("claim_payments")
      .update({
        claim_id: newClaimId,
        amount: plan.claimPayments.values.amount,
        check_number: plan.claimPayments.values.check_number,
        notes: plan.claimPayments.values.notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.claimPayments.id);
  }

  await supabase
    .from("homeowner_ledger_events")
    .update({ claim_id: newClaimId })
    .eq("check_id", check.id);

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

  return plan;
}
