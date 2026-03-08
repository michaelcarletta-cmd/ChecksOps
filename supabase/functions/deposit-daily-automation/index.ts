import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const results: Record<string, unknown> = {};

    // Step 1: Refresh all next actions
    const { data: refreshResult, error: refreshErr } = await supabase.rpc(
      "refresh_all_deposit_next_actions",
      { p_actor_id: null }
    );
    if (refreshErr) {
      console.error("refresh_all_deposit_next_actions error:", refreshErr);
      results.refresh = { error: refreshErr.message };
    } else {
      results.refresh = refreshResult;
    }

    // Step 2: Run escalation checks
    const { data: escResult, error: escErr } = await supabase.rpc(
      "run_deposit_escalation_check",
      { p_actor_id: null }
    );
    if (escErr) {
      console.error("run_deposit_escalation_check error:", escErr);
      results.escalation = { error: escErr.message };
    } else {
      results.escalation = escResult;
    }

    // Step 3: Generate daily digest (use service role - need a system actor)
    // We use NULL actor which the RPC handles for system calls
    const { data: digestResult, error: digestErr } = await supabase.rpc(
      "generate_deposit_daily_digest",
      { p_actor_id: null, p_digest_type: "daily" }
    );
    if (digestErr) {
      console.error("generate_deposit_daily_digest error:", digestErr);
      results.digest = { error: digestErr.message };
    } else {
      results.digest = digestResult;
    }

    // Step 4: Save manager snapshot
    const { data: snapResult, error: snapErr } = await supabase.rpc(
      "save_deposit_manager_snapshot",
      { p_actor_id: null }
    );
    if (snapErr) {
      console.error("save_deposit_manager_snapshot error:", snapErr);
      results.snapshot = { error: snapErr.message };
    } else {
      results.snapshot = snapResult;
    }

    // Step 5: Check for owner overloads (>25 open items)
    const { data: overloads } = await supabase
      .from("deposit_owner_performance")
      .select("owner_id, open_items, open_amount, sla_breaches")
      .gt("open_items", 25);

    if (overloads && overloads.length > 0) {
      results.overload_flags = overloads;
      // Create escalation events for overloaded owners
      for (const owner of overloads) {
        await supabase.from("deposit_escalation_events").insert({
          escalation_type: "owner_overload",
          message: `Owner ${owner.owner_id?.toString().slice(0, 8)} has ${owner.open_items} open items (>${25} threshold)`,
          escalated_to: null, // will be picked up by admin
        });
      }
    }

    // Step 6: Deliver digest to owners with preferences
    const { data: prefs } = await supabase
      .from("deposit_notification_prefs")
      .select("user_id, digest_frequency")
      .eq("digest_frequency", "daily");

    if (prefs && prefs.length > 0) {
      const { data: latestDigest } = await supabase
        .from("deposit_daily_digest")
        .select("id")
        .eq("digest_type", "daily")
        .order("digest_date", { ascending: false })
        .limit(1)
        .single();

      if (latestDigest) {
        for (const pref of prefs) {
          await supabase.from("deposit_digest_delivery_log").insert({
            digest_id: latestDigest.id,
            recipient_id: pref.user_id,
            delivery_method: "in_app",
          });
        }
        results.deliveries = prefs.length;
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("deposit-daily-automation error:", message);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
