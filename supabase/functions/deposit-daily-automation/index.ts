import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface StepResult {
  step: string;
  status: "success" | "error";
  duration_ms: number;
  detail?: unknown;
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const today = new Date().toISOString().slice(0, 10);
  const runType = "daily";
  const idempotencyKey = `${runType}_${today}`;

  try {
    // Idempotency check: skip if already completed or running today
    const { data: existingRun } = await supabase
      .from("deposit_automation_runs")
      .select("id, status")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingRun) {
      if (existingRun.status === "completed") {
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "Already completed today", run_id: existingRun.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (existingRun.status === "running") {
        // Check if stale (>10 min) — if so, allow retry
        // Otherwise skip
        return new Response(
          JSON.stringify({ success: false, skipped: true, reason: "Already running", run_id: existingRun.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // If partial_failure or failed, allow re-run by deleting old record
      await supabase.from("deposit_automation_runs").delete().eq("id", existingRun.id);
    }

    // Check if automation is enabled
    const { data: enabledSetting } = await supabase
      .from("deposit_automation_settings")
      .select("setting_value")
      .eq("setting_key", "daily_automation_enabled")
      .maybeSingle();

    if (enabledSetting && enabledSetting.setting_value === false) {
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "Daily automation disabled" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create run record
    const { data: runRecord, error: runInsertErr } = await supabase
      .from("deposit_automation_runs")
      .insert({
        run_date: today,
        run_type: runType,
        status: "running",
        idempotency_key: idempotencyKey,
      })
      .select("id")
      .single();

    if (runInsertErr) {
      // Likely duplicate — another run started
      return new Response(
        JSON.stringify({ success: false, error: "Could not acquire run lock: " + runInsertErr.message }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const runId = runRecord.id;
    const stepsCompleted: StepResult[] = [];
    const stepsFailed: StepResult[] = [];
    let totalEscalations = 0;
    let totalDeliveries = 0;
    let refreshCount = 0;

    // Helper to run a step with timing
    async function runStep(name: string, fn: () => Promise<unknown>): Promise<unknown> {
      const stepStart = Date.now();
      try {
        const result = await fn();
        stepsCompleted.push({ step: name, status: "success", duration_ms: Date.now() - stepStart, detail: result });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stepsFailed.push({ step: name, status: "error", duration_ms: Date.now() - stepStart, error: msg });
        console.error(`Step "${name}" failed:`, msg);
        return null;
      }
    }

    // Step 1: Refresh all next actions
    await runStep("refresh_next_actions", async () => {
      const { data, error } = await supabase.rpc("refresh_all_deposit_next_actions", { p_actor_id: null });
      if (error) throw error;
      refreshCount = (data as Record<string, number>)?.refreshed ?? 0;
      return data;
    });

    // Step 2: Run escalation checks
    await runStep("escalation_check", async () => {
      const { data, error } = await supabase.rpc("run_deposit_escalation_check", { p_actor_id: null });
      if (error) throw error;
      totalEscalations = (data as Record<string, number>)?.escalations_created ?? 0;
      return data;
    });

    // Step 3: Generate daily digest
    await runStep("daily_digest", async () => {
      const { data, error } = await supabase.rpc("generate_deposit_daily_digest", {
        p_actor_id: null,
        p_digest_type: "daily",
      });
      if (error) throw error;
      return data;
    });

    // Step 4: Save manager snapshot
    await runStep("manager_snapshot", async () => {
      const { data, error } = await supabase.rpc("save_deposit_manager_snapshot", { p_actor_id: null });
      if (error) throw error;
      return data;
    });

    // Step 5: Check owner overloads using configurable threshold
    const overloadFlags: unknown[] = [];
    await runStep("owner_overload_check", async () => {
      const { data: thresholdSetting } = await supabase
        .from("deposit_automation_settings")
        .select("setting_value")
        .eq("setting_key", "owner_overload_threshold")
        .maybeSingle();

      const threshold = thresholdSetting?.setting_value
        ? Number(thresholdSetting.setting_value)
        : 25;

      const { data: overloads } = await supabase
        .from("deposit_owner_performance")
        .select("owner_id, open_items, open_amount, sla_breaches")
        .gt("open_items", threshold);

      if (overloads && overloads.length > 0) {
        overloadFlags.push(...overloads);
        for (const owner of overloads) {
          await supabase.from("deposit_escalation_events").insert({
            escalation_type: "owner_overload",
            message: `Owner ${owner.owner_id?.toString().slice(0, 8)} has ${owner.open_items} open items (>${threshold} threshold)`,
            escalated_to: null,
          });
        }
      }
      return { overloads: overloads?.length ?? 0, threshold };
    });

    // Step 6: Deliver digest to owners with preferences
    await runStep("digest_delivery", async () => {
      const { data: prefs } = await supabase
        .from("deposit_notification_prefs")
        .select("user_id, digest_frequency")
        .eq("digest_frequency", "daily");

      if (!prefs || prefs.length === 0) return { deliveries: 0 };

      const { data: latestDigest } = await supabase
        .from("deposit_daily_digest")
        .select("id")
        .eq("digest_type", "daily")
        .order("digest_date", { ascending: false })
        .limit(1)
        .single();

      if (!latestDigest) return { deliveries: 0, reason: "no_digest" };

      for (const pref of prefs) {
        // Dedup: don't re-deliver the same digest
        const { data: existing } = await supabase
          .from("deposit_digest_delivery_log")
          .select("id")
          .eq("digest_id", latestDigest.id)
          .eq("recipient_id", pref.user_id)
          .maybeSingle();

        if (!existing) {
          await supabase.from("deposit_digest_delivery_log").insert({
            digest_id: latestDigest.id,
            recipient_id: pref.user_id,
            delivery_method: "in_app",
          });
          totalDeliveries++;
        }
      }
      return { deliveries: totalDeliveries };
    });

    // Finalize run record
    const finalStatus = stepsFailed.length === 0
      ? "completed"
      : stepsCompleted.length > 0
        ? "partial_failure"
        : "failed";

    await supabase.from("deposit_automation_runs").update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      steps_completed: stepsCompleted,
      steps_failed: stepsFailed,
      refresh_count: refreshCount,
      escalations_created: totalEscalations,
      digests_generated: stepsCompleted.some((s) => s.step === "daily_digest") ? 1 : 0,
      deliveries_sent: totalDeliveries,
      overload_flags: overloadFlags,
      duration_ms: Date.now() - startTime,
      error_summary: stepsFailed.length > 0 ? stepsFailed.map((s) => `${s.step}: ${s.error}`).join("; ") : null,
    }).eq("id", runId);

    return new Response(
      JSON.stringify({
        success: true,
        run_id: runId,
        status: finalStatus,
        duration_ms: Date.now() - startTime,
        steps_completed: stepsCompleted.length,
        steps_failed: stepsFailed.length,
        refresh_count: refreshCount,
        escalations_created: totalEscalations,
        deliveries_sent: totalDeliveries,
        overload_flags: overloadFlags.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("deposit-daily-automation fatal error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message, duration_ms: Date.now() - startTime }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
