import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isWithinBusinessHours, outsideBusinessHoursResponse } from "../_shared/business-hours-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Business hours gate: skip execution outside 6 AM – 10 PM ET
  if (!isWithinBusinessHours()) {
    console.log("Skipping backfill-money-snapshots: outside business hours");
    return outsideBusinessHoursResponse(corsHeaders);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, serviceKey);

    // Get all active claims (not closed/settled)
    const { data: claims, error } = await sb
      .from("claims")
      .select("id")
      .not("status", "in", '("Dead File","Claim Settled")')
      .eq("is_closed", false)
      .limit(500);

    if (error) throw error;
    if (!claims?.length) {
      return new Response(JSON.stringify({ success: true, processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let processed = 0;
    let errors = 0;

    // Process in batches of 10 to avoid overwhelming the system
    for (let i = 0; i < claims.length; i += 10) {
      const batch = claims.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (claim) => {
          const { error: invokeError } = await sb.functions.invoke("run-claim-autopilot", {
            body: { claimId: claim.id },
          });
          if (invokeError) throw invokeError;
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") processed++;
        else errors++;
      }
    }

    // Refresh materialized views
    await sb.rpc("refresh_portfolio_views").catch(console.error);

    return new Response(
      JSON.stringify({ success: true, processed, errors, total: claims.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("backfill-money-snapshots error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
