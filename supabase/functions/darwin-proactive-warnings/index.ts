import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { isWithinBusinessHours, outsideBusinessHoursResponse } from "../_shared/business-hours-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Business hours gate: skip execution outside 6 AM – 10 PM ET
  if (!isWithinBusinessHours()) {
    console.log("Skipping darwin-proactive-warnings: outside business hours");
    return outsideBusinessHoursResponse(corsHeaders);
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedSecret = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const hasValidCronSecret = Boolean(cronSecret && providedSecret === cronSecret);
  const hasAnyCronSecret = Boolean(providedSecret && providedSecret.length > 0);
  const hasBearerToken = Boolean(authHeader && authHeader.startsWith("Bearer "));

  if (!hasValidCronSecret && !hasAnyCronSecret && !hasBearerToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Running proactive warnings scan...");

    // Get active (non-closed) claims
    const { data: claims, error: claimsError } = await supabase
      .from("claims")
      .select("id, claim_number, status, created_at, updated_at, insurance_company, loss_type, state_code")
      .eq("is_closed", false)
      .limit(500);

    if (claimsError) throw claimsError;

    let warningsCreated = 0;

    for (const claim of claims || []) {
      const warnings: Array<{
        claim_id: string;
        warning_type: string;
        severity: string;
        title: string;
        message: string;
        source: string;
        trigger_context: string;
      }> = [];

      // 1. STALE CLAIMS — no update in 7+ days
      const daysSinceUpdate = Math.floor(
        (Date.now() - new Date(claim.updated_at).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysSinceUpdate >= 21) {
        warnings.push({
          claim_id: claim.id,
          warning_type: "stale_claim_critical",
          severity: "critical",
          title: "Claim dormant 21+ days",
          message: `No activity on ${claim.claim_number || "this claim"} for ${daysSinceUpdate} days. Carrier may use inaction against you.`,
          source: "proactive",
          trigger_context: "general",
        });
      } else if (daysSinceUpdate >= 14) {
        warnings.push({
          claim_id: claim.id,
          warning_type: "stale_claim_high",
          severity: "high",
          title: "Claim inactive 14+ days",
          message: `No activity on ${claim.claim_number || "this claim"} for ${daysSinceUpdate} days. Consider following up.`,
          source: "proactive",
          trigger_context: "general",
        });
      } else if (daysSinceUpdate >= 7) {
        warnings.push({
          claim_id: claim.id,
          warning_type: "stale_claim_medium",
          severity: "medium",
          title: "Claim quiet for a week",
          message: `No updates on ${claim.claim_number || "this claim"} in ${daysSinceUpdate} days.`,
          source: "proactive",
          trigger_context: "general",
        });
      }

      // NOTE: "missing estimate" / "missing photos" warnings were intentionally
      // removed. Document-completeness checks live in their own validation surface,
      // not in the urgency/notification stream. Urgency only fires for time-based
      // signals (stale activity, overdue tasks, payment gaps).

      // 4. PAYMENT GAP — has approved amount but no check logged
      const { data: moneyData } = await supabase
        .from("claim_money_snapshot")
        .select("total_approved, total_received")
        .eq("claim_id", claim.id)
        .maybeSingle();

      if (moneyData && (moneyData.total_approved ?? 0) > 0 && (moneyData.total_received ?? 0) === 0) {
        warnings.push({
          claim_id: claim.id,
          warning_type: "payment_gap",
          severity: "high",
          title: "Approved but no payment received",
          message: `$${(moneyData.total_approved ?? 0).toLocaleString()} approved but no checks logged. Follow up on payment.`,
          source: "proactive",
          trigger_context: "general",
        });
      }

      // Deduplicate and insert
      for (const w of warnings) {
        // Check if a matching warning already exists (not dismissed, not resolved)
        const { data: existing } = await supabase
          .from("claim_warnings_log")
          .select("id")
          .eq("claim_id", w.claim_id)
          .eq("warning_type", w.warning_type)
          .eq("is_dismissed", false)
          .eq("is_resolved", false)
          .limit(1);

        if (!existing || existing.length === 0) {
          const { error: insertError } = await supabase
            .from("claim_warnings_log")
            .insert(w);

          if (!insertError) {
            warningsCreated++;
          } else {
            console.error(`Failed to insert warning for claim ${w.claim_id}:`, insertError.message);
          }
        }
      }
    }

    console.log(`Proactive warnings scan complete: ${warningsCreated} new warnings created for ${claims?.length || 0} claims`);

    return new Response(
      JSON.stringify({ success: true, claimsScanned: claims?.length || 0, warningsCreated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Proactive warnings error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
