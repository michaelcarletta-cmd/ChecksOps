import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type CoverageBucket =
  | "dwelling"
  | "other_structures"
  | "contents"
  | "ale"
  | "pwi"
  | "other";

interface FinancialSummary {
  claimId: string;
  totalPaid: number;
  totalOutstanding: number;
  byCoverage: Partial<Record<CoverageBucket, { paid: number; outstanding: number; rcv?: number }>>;
  depreciation: { recoverable: number; nonRecoverable: number; recovered?: number };
  deductible: number;
  dataComplete: boolean;
  message?: string;
}

interface LineItemPaymentStatus {
  lineItemId: string;
  estimateId: string;
  code: string | null;
  description: string | null;
  coverageType: string | null;
  rcv: number;
  acv: number;
  appliedAmount: number;
  outstanding: number;
}

async function getClaimFinancialSummary(supabase: any, claimId: string): Promise<FinancialSummary> {
  const summary: FinancialSummary = {
    claimId,
    totalPaid: 0,
    totalOutstanding: 0,
    byCoverage: {},
    depreciation: { recoverable: 0, nonRecoverable: 0 },
    deductible: 0,
    dataComplete: true,
  };

  const { data: settlement, error: setErr } = await supabase
    .from("claim_settlements")
    .select("*")
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (setErr) {
    summary.dataComplete = false;
    summary.message = "Could not load settlement data.";
    return summary;
  }

  if (settlement) {
    summary.depreciation.recoverable = Number(settlement.recoverable_depreciation ?? 0);
    summary.depreciation.nonRecoverable = Number(settlement.non_recoverable_depreciation ?? 0);
    summary.deductible = Number(settlement.deductible ?? 0);
    const rcv = Number(settlement.replacement_cost_value ?? 0);
    const totalSettlement = Number(settlement.total_settlement ?? 0);
    if (rcv > 0) {
      summary.byCoverage.dwelling = {
        paid: 0,
        outstanding: rcv,
        rcv,
      };
    }
    if (totalSettlement > 0) {
      summary.totalPaid = totalSettlement;
      summary.byCoverage.dwelling = summary.byCoverage.dwelling ?? { paid: 0, outstanding: 0 };
      summary.byCoverage.dwelling!.paid = totalSettlement;
      summary.byCoverage.dwelling!.outstanding = Math.max(0, (summary.byCoverage.dwelling!.rcv ?? 0) - totalSettlement);
    }
    const othRcv = Number(settlement.other_structures_rcv ?? 0);
    if (othRcv > 0) {
      summary.byCoverage.other_structures = { paid: 0, outstanding: othRcv, rcv: othRcv };
    }
    const ppRcv = Number(settlement.personal_property_rcv ?? 0);
    if (ppRcv > 0) {
      summary.byCoverage.contents = { paid: 0, outstanding: ppRcv, rcv: ppRcv };
    }
    const pwiRcv = Number(settlement.pwi_rcv ?? 0);
    if (pwiRcv > 0) {
      summary.byCoverage.pwi = { paid: 0, outstanding: pwiRcv, rcv: pwiRcv };
    }
  }

  const { data: payments, error: payErr } = await supabase
    .from("claim_payments")
    .select("id, amount, coverage_type")
    .eq("claim_id", claimId);

  if (!payErr && payments?.length) {
    let totalFromPayments = 0;
    for (const p of payments) {
      const amt = Number(p.amount ?? 0);
      totalFromPayments += amt;
      const cov = (p.coverage_type || "dwelling") as CoverageBucket;
      if (!summary.byCoverage[cov]) summary.byCoverage[cov] = { paid: 0, outstanding: 0 };
      summary.byCoverage[cov]!.paid = (summary.byCoverage[cov]!.paid ?? 0) + amt;
    }
    if (totalFromPayments > 0 && summary.totalPaid === 0) {
      summary.totalPaid = totalFromPayments;
    }
  }

  const { data: checks } = await supabase
    .from("claim_checks")
    .select("amount, check_type")
    .eq("claim_id", claimId);

  if (checks?.length) {
    let fromChecks = 0;
    for (const c of checks) {
      fromChecks += Number(c.amount ?? 0);
    }
    if (fromChecks > 0) {
      summary.totalPaid = summary.totalPaid + fromChecks;
    }
  }

  let totalRcv = 0;
  let totalOutstandingByCov = 0;
  for (const k of Object.keys(summary.byCoverage) as CoverageBucket[]) {
    const b = summary.byCoverage[k]!;
    totalRcv += b.rcv ?? 0;
    const paid = b.paid ?? 0;
    b.outstanding = Math.max(0, (b.rcv ?? 0) - paid);
    totalOutstandingByCov += b.outstanding;
  }
  summary.totalOutstanding = totalOutstandingByCov;

  return summary;
}

async function getLineItemPaymentStatus(
  supabase: any,
  claimId: string
): Promise<LineItemPaymentStatus[]> {
  const { data: estimates } = await supabase
    .from("claim_estimates")
    .select("id")
    .eq("claim_id", claimId);

  if (!estimates?.length) {
    return [];
  }

  const estimateIds = estimates.map((e: { id: string }) => e.id);
  const { data: lineItems, error: liErr } = await supabase
    .from("estimate_line_items")
    .select("id, estimate_id, code, description, coverage_type, rcv, acv")
    .in("estimate_id", estimateIds);

  if (liErr || !lineItems?.length) return [];

  const { data: applications } = await supabase
    .from("payment_applications")
    .select("line_item_id, applied_amount")
    .in("line_item_id", lineItems.map((l: { id: string }) => l.id));

  const appliedByLine: Record<string, number> = {};
  for (const a of applications || []) {
    appliedByLine[a.line_item_id] = (appliedByLine[a.line_item_id] ?? 0) + Number(a.applied_amount ?? 0);
  }

  return lineItems.map((li: any) => {
    const rcv = Number(li.rcv ?? 0);
    const applied = appliedByLine[li.id] ?? 0;
    return {
      lineItemId: li.id,
      estimateId: li.estimate_id,
      code: li.code,
      description: li.description,
      coverageType: li.coverage_type,
      rcv,
      acv: Number(li.acv ?? 0),
      appliedAmount: applied,
      outstanding: Math.max(0, rcv - applied),
    };
  });
}

async function applyPaymentToLineItems(
  supabase: any,
  paymentId: string,
  allocationRules: Array<{ lineItemId: string; amount: number; appliedToField?: string }>
): Promise<{ success: boolean; error?: string }> {
  const { data: payment, error: payErr } = await supabase
    .from("claim_payments")
    .select("id, amount")
    .eq("id", paymentId)
    .single();

  if (payErr || !payment) {
    return { success: false, error: "Payment not found." };
  }

  const totalAllocated = allocationRules.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  if (totalAllocated > Number(payment.amount ?? 0)) {
    return { success: false, error: "Allocated amount exceeds payment amount." };
  }

  await supabase.from("payment_applications").delete().eq("payment_id", paymentId);

  for (const rule of allocationRules) {
    const amount = Number(rule.amount ?? 0);
    if (amount <= 0) continue;
    const { error: insErr } = await supabase.from("payment_applications").insert({
      payment_id: paymentId,
      line_item_id: rule.lineItemId,
      applied_amount: amount,
      applied_to_field: rule.appliedToField || "rcv",
    });
    if (insErr) {
      return { success: false, error: insErr.message };
    }
  }
  return { success: true };
}

function isFinancialQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /what'?s\s+been\s+paid|what\s+has\s+been\s+paid|paid\s+and\s+what\s+hasn't|what\s+is\s+paid/i.test(t) ||
    /tied\s+up\s+in\s+depreciation|depreciation|recoverable/i.test(t) ||
    /paid\s+per\s+line\s+item|per\s+line\s+item|line\s+item\s+payment/i.test(t) ||
    /contents\s+vs\s+ale|dwelling\s+coverage|coverage\s+paid|outstanding/i.test(t) ||
    /how\s+much\s+(is\s+)?(paid|outstanding|recovered)/i.test(t) ||
    /financial\s+summary|payment\s+status/i.test(t)
  );
}

async function answerFinancialQuestion(
  supabase: any,
  claimId: string,
  questionText: string
): Promise<{ answer: string; dataComplete: boolean; source: string }> {
  const summary = await getClaimFinancialSummary(supabase, claimId);
  const lineStatus = await getLineItemPaymentStatus(supabase, claimId);

  const q = questionText.toLowerCase();
  let answer = "";
  const parts: string[] = [];

  if (/what'?s\s+been\s+paid|what\s+has\s+been\s+paid|paid\s+and\s+what\s+hasn't|total\s+paid/i.test(q)) {
    parts.push(`**Total paid:** $${summary.totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    parts.push(`**Outstanding:** $${summary.totalOutstanding.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  }
  if (/depreciation|tied\s+up|recoverable|non-?recoverable/i.test(q)) {
    parts.push(
      `**Depreciation:** Recoverable: $${summary.depreciation.recoverable.toLocaleString("en-US", { minimumFractionDigits: 2 })}; Non-recoverable: $${summary.depreciation.nonRecoverable.toLocaleString("en-US", { minimumFractionDigits: 2 })}.`
    );
  }
  if (/per\s+line\s+item|line\s+item|paid\s+per\s+line/i.test(q)) {
    if (lineStatus.length === 0) {
      parts.push("Line-item payment application is not available for this claim (no estimate line items linked). Totals are from payments and settlement.");
    } else {
      parts.push("**By line item:**");
      for (const li of lineStatus.slice(0, 30)) {
        parts.push(`- ${(li.description || li.code || "Item").slice(0, 50)}: RCV $${li.rcv.toFixed(2)}, Applied $${li.appliedAmount.toFixed(2)}, Outstanding $${li.outstanding.toFixed(2)}`);
      }
      if (lineStatus.length > 30) parts.push(`... and ${lineStatus.length - 30} more line items.`);
    }
  }
  if (/contents\s+vs\s+ale|dwelling|coverage|ale|contents/i.test(q)) {
    const covOrder: CoverageBucket[] = ["dwelling", "contents", "ale", "other_structures", "pwi"];
    for (const c of covOrder) {
      const b = summary.byCoverage[c];
      if (b && (b.paid > 0 || b.outstanding > 0 || (b.rcv ?? 0) > 0)) {
        parts.push(
          `**${c}:** Paid $${(b.paid ?? 0).toFixed(2)}, Outstanding $${(b.outstanding ?? 0).toFixed(2)}${b.rcv != null ? ` (RCV $${b.rcv.toFixed(2)})` : ""}`
        );
      }
    }
  }

  if (parts.length === 0) {
    parts.push(`Total paid: $${summary.totalPaid.toFixed(2)}. Total outstanding: $${summary.totalOutstanding.toFixed(2)}.`);
    if (summary.deductible > 0) parts.push(`Deductible: $${summary.deductible.toFixed(2)}.`);
  }

  answer = parts.join("\n\n");
  if (!summary.dataComplete) {
    answer += "\n\n_Note: Some data may be incomplete. Verify against claim records._";
  }

  return {
    answer,
    dataComplete: summary.dataComplete,
    source: "claim_settlements, claim_payments, claim_checks, estimate_line_items, payment_applications",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json().catch(() => ({}));
    const { action, claimId, paymentId, allocationRules, questionText } = body;

    if (!claimId && action !== "applyPaymentToLineItems") {
      return new Response(
        JSON.stringify({ error: "claimId required for this action" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    switch (action) {
      case "getClaimFinancialSummary": {
        const summary = await getClaimFinancialSummary(supabase, claimId);
        return new Response(JSON.stringify(summary), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "getLineItemPaymentStatus": {
        const status = await getLineItemPaymentStatus(supabase, claimId);
        return new Response(JSON.stringify(status), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "applyPaymentToLineItems": {
        if (!paymentId || !Array.isArray(allocationRules)) {
          return new Response(
            JSON.stringify({ error: "paymentId and allocationRules required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const result = await applyPaymentToLineItems(supabase, paymentId, allocationRules);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "answerFinancialQuestion": {
        if (!questionText) {
          return new Response(
            JSON.stringify({ error: "questionText required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const result = await answerFinancialQuestion(supabase, claimId, questionText);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      default:
        return new Response(
          JSON.stringify({
            error: "Unknown action",
            supported: [
              "getClaimFinancialSummary",
              "getLineItemPaymentStatus",
              "applyPaymentToLineItems",
              "answerFinancialQuestion",
            ],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (e) {
    console.error("darwin-financials error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
