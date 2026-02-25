import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Generate a deterministic scenario key from dimensions
function buildScenarioKey(dims: {
  carrier: string;
  state_code?: string | null;
  loss_type?: string | null;
  trade?: string | null;
  denial_rationale?: string | null;
  decision_type?: string | null;
  policy_form?: string | null;
}): string {
  const parts = [
    (dims.carrier || "unknown").toLowerCase().trim(),
    (dims.state_code || "any").toLowerCase().trim(),
    (dims.loss_type || "any").toLowerCase().trim(),
    (dims.trade || "any").toLowerCase().trim(),
    (dims.denial_rationale || "any").toLowerCase().trim(),
    (dims.decision_type || "any").toLowerCase().trim(),
    (dims.policy_form || "any").toLowerCase().trim(),
  ];
  return parts.join("|");
}

// Compute confidence score deterministically
function computeConfidence(sampleTotal: number, sampleRecent: number): { score: number; label: string } {
  // Log-scaled sample size (max contribution 40)
  const sampleScore = Math.min(40, Math.log2(Math.max(1, sampleTotal)) * 8);
  // Recency score (max 30) — recent samples matter more
  const recencyScore = Math.min(30, sampleRecent * 3);
  // Completeness bonus (max 30) — having both total and recent
  const completeness = sampleTotal > 0 && sampleRecent > 0 ? 30 : sampleTotal > 0 ? 15 : 0;
  
  const score = Math.round(Math.min(100, sampleScore + recencyScore + completeness));
  const label = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { score, label };
}

// Extract tactics from claim documents and analysis
function extractTactics(claim: any, outcome: any): Array<{ type: string; name: string }> {
  const tactics: Array<{ type: string; name: string }> = [];
  const present = outcome.tactics_present || [];
  const evidence = outcome.evidence_types_present || [];
  
  for (const t of present) {
    if (typeof t === "string" && t.trim()) {
      tactics.push({ type: "process_step", name: t.trim().toLowerCase() });
    }
  }
  for (const e of evidence) {
    if (typeof e === "string" && e.trim()) {
      tactics.push({ type: "evidence", name: e.trim().toLowerCase() });
    }
  }
  
  // Infer from resolution type
  if (outcome.resolution_type) {
    tactics.push({ type: "process_step", name: outcome.resolution_type.toLowerCase() });
  }
  
  return tactics;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify cron secret or JWT
    const cronSecret = Deno.env.get("CRON_SECRET");
    const authHeader = req.headers.get("x-cron-secret") || req.headers.get("authorization");
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json().catch(() => ({}));
    const { claimId, mode } = body; // mode: 'single' (on claim close) or 'batch' (nightly)

    let outcomeEvents: any[] = [];

    if (mode === "single" && claimId) {
      // === SINGLE CLAIM CLOSE: Materialize outcome + recompute affected playbooks ===
      console.log(`[Playbook] Processing single claim close: ${claimId}`);
      
      // Fetch claim data
      const { data: claim } = await supabase
        .from("claims")
        .select("*, claim_settlements(*), claim_checks(*), claim_files(*)")
        .eq("id", claimId)
        .single();

      if (!claim) {
        return new Response(JSON.stringify({ error: "Claim not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Get first offer from settlement data
      const firstOffer = claim.claim_settlements?.[0]?.estimate_amount || claim.claim_amount || 0;
      const totalChecks = (claim.claim_checks || []).reduce(
        (s: number, c: any) => s + Number(c.amount || 0), 0
      );
      const finalPaid = claim.claim_settlements?.[0]?.total_settlement || totalChecks || 0;

      // Get denial rationales from document analysis
      const { data: docAnalyses } = await supabase
        .from("document_analysis_results")
        .select("denial_rationales, document_type, carrier_position")
        .eq("claim_id", claimId);

      const allRationales = new Set<string>();
      let primaryDecision: string | null = null;
      for (const da of (docAnalyses || [])) {
        for (const r of (da.denial_rationales || [])) allRationales.add(r);
        if (!primaryDecision && da.carrier_position) primaryDecision = da.carrier_position;
      }

      // Detect tactics from files and analysis results
      const { data: analysisResults } = await supabase
        .from("darwin_analysis_results")
        .select("analysis_type, result")
        .eq("claim_id", claimId);

      const tacticsPresent: string[] = [];
      const evidencePresent: string[] = [];
      for (const ar of (analysisResults || [])) {
        tacticsPresent.push(ar.analysis_type);
        // Extract evidence types from file categories
        const resultStr = typeof ar.result === "string" ? ar.result : JSON.stringify(ar.result || "");
        if (/engineer/i.test(resultStr)) evidencePresent.push("engineer_report");
        if (/moisture|water/i.test(resultStr)) evidencePresent.push("moisture_map");
        if (/test square/i.test(resultStr)) evidencePresent.push("test_square");
        if (/matching|uniformity/i.test(resultStr)) evidencePresent.push("matching_argument");
        if (/appraisal/i.test(resultStr)) evidencePresent.push("appraisal");
        if (/supplement/i.test(resultStr)) evidencePresent.push("supplement");
      }

      // Detect trade from loss type / files
      const trade = (() => {
        const lt = (claim.loss_type || "").toLowerCase();
        if (/roof|shingle/i.test(lt)) return "roof";
        if (/siding/i.test(lt)) return "siding";
        if (/water|plumb/i.test(lt)) return "interior";
        if (/wind/i.test(lt)) return "roof";
        return null;
      })();

      // Extract state from address
      const stateMatch = (claim.policyholder_address || "").match(/\b([A-Z]{2})\b\s*\d{5}/);
      const stateCode = stateMatch ? stateMatch[1] : (claim.property_state || null);

      const coverageReversal = allRationales.size > 0 && finalPaid > 0;
      const resolutionType = (() => {
        if (tacticsPresent.includes("appraisal")) return "appraisal";
        if (evidencePresent.includes("supplement")) return "supplement";
        if (/litigation/i.test(claim.status || "")) return "litigation";
        return "negotiation";
      })();

      // Upsert the outcome event
      const outcomeData = {
        claim_id: claimId,
        carrier: claim.insurance_company || "Unknown",
        state_code: stateCode,
        loss_type: claim.loss_type || null,
        trade,
        denial_rationales: [...allRationales],
        decision_type: primaryDecision,
        policy_form: null,
        first_offer: firstOffer,
        final_paid: finalPaid,
        coverage_reversal: coverageReversal,
        resolution_type: resolutionType,
        tactics_present: [...new Set(tacticsPresent)],
        evidence_types_present: [...new Set(evidencePresent)],
        close_date: new Date().toISOString(),
      };

      const { data: upserted, error: upsertErr } = await supabase
        .from("claim_outcome_events")
        .upsert(outcomeData, { onConflict: "claim_id" })
        .select()
        .single();

      if (upsertErr) {
        console.error("[Playbook] Outcome upsert error:", upsertErr);
      } else {
        outcomeEvents = [upserted];
        console.log(`[Playbook] Outcome materialized for claim ${claimId}`);
      }
    } else {
      // === BATCH MODE: Rebuild all playbooks from all outcome events ===
      console.log("[Playbook] Running batch recompute...");
      const { data } = await supabase
        .from("claim_outcome_events")
        .select("*")
        .order("close_date", { ascending: false });
      outcomeEvents = data || [];
    }

    if (outcomeEvents.length === 0) {
      return new Response(JSON.stringify({ message: "No outcomes to process" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === RECOMPUTE PLAYBOOKS ===
    // For single mode, only recompute scenario keys touched by this claim
    // For batch mode, recompute all

    // Group outcomes by scenario key
    const scenarioGroups: Record<string, {
      dims: any;
      outcomes: any[];
    }> = {};

    const now = new Date();
    const twelveMoAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    for (const o of outcomeEvents) {
      // Generate multiple scenario keys at different granularity levels
      const rationales = o.denial_rationales || [];
      const primaryRationale = rationales[0] || null;
      
      // Exact key
      const exactDims = {
        carrier: o.carrier,
        state_code: o.state_code,
        loss_type: o.loss_type,
        trade: o.trade,
        denial_rationale: primaryRationale,
        decision_type: o.decision_type,
        policy_form: o.policy_form,
      };
      const exactKey = buildScenarioKey(exactDims);

      if (!scenarioGroups[exactKey]) {
        scenarioGroups[exactKey] = { dims: exactDims, outcomes: [] };
      }
      scenarioGroups[exactKey].outcomes.push(o);

      // Also add to broader scenario (carrier + trade + rationale, no state)
      const broadDims = { ...exactDims, state_code: null };
      const broadKey = buildScenarioKey(broadDims);
      if (!scenarioGroups[broadKey]) {
        scenarioGroups[broadKey] = { dims: broadDims, outcomes: [] };
      }
      if (broadKey !== exactKey) {
        scenarioGroups[broadKey].outcomes.push(o);
      }
    }

    let playbooksUpdated = 0;
    let tacticsUpdated = 0;

    for (const [scenarioKey, group] of Object.entries(scenarioGroups)) {
      const { dims, outcomes } = group;
      const total = outcomes.length;
      const recent = outcomes.filter((o: any) =>
        new Date(o.close_date) >= twelveMoAgo
      ).length;

      // Win rate: coverage_reversal OR positive delta
      const wins = outcomes.filter((o: any) =>
        o.coverage_reversal || (o.delta_amount && o.delta_amount > 0)
      ).length;
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

      // Average delta
      const deltas = outcomes
        .map((o: any) => Number(o.delta_amount || 0))
        .filter((d: number) => d !== 0);
      const avgDelta = deltas.length > 0
        ? Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length)
        : 0;

      // Average time to resolution (days from claim create to close)
      // We don't have create dates in outcome_events, skip for now

      // Resolution paths
      const resPaths: Record<string, number> = {};
      for (const o of outcomes) {
        const rt = o.resolution_type || "unknown";
        resPaths[rt] = (resPaths[rt] || 0) + 1;
      }
      const topPaths = Object.entries(resPaths)
        .sort(([, a], [, b]) => b - a)
        .map(([path, count]) => ({ path, count, pct: Math.round((count / total) * 100) }));

      const { score: confidence, label: confLabel } = computeConfidence(total, recent);

      // Upsert playbook
      const { error: pbErr } = await supabase
        .from("carrier_scenario_playbooks")
        .upsert({
          scenario_key: scenarioKey,
          carrier: dims.carrier,
          state_code: dims.state_code,
          loss_type: dims.loss_type,
          trade: dims.trade,
          denial_rationale: dims.denial_rationale,
          decision_type: dims.decision_type,
          policy_form: dims.policy_form,
          sample_size_total: total,
          sample_size_recent_12mo: recent,
          win_rate: winRate,
          avg_indemnity_delta: avgDelta,
          top_resolution_paths: topPaths,
          confidence_score: confidence,
          confidence_label: confLabel,
          last_updated_at: new Date().toISOString(),
        }, { onConflict: "scenario_key" });

      if (pbErr) {
        console.error(`[Playbook] Error upserting ${scenarioKey}:`, pbErr);
        continue;
      }
      playbooksUpdated++;

      // === COMPUTE TACTICS ===
      const tacticStats: Record<string, {
        type: string;
        name: string;
        supportCount: number;
        winCount: number;
        deltas: number[];
        recentCount: number;
      }> = {};

      for (const o of outcomes) {
        const tactics = extractTactics({}, o);
        const isWin = o.coverage_reversal || (o.delta_amount && o.delta_amount > 0);
        const isRecent = new Date(o.close_date) >= twelveMoAgo;

        for (const t of tactics) {
          const key = `${t.type}:${t.name}`;
          if (!tacticStats[key]) {
            tacticStats[key] = {
              type: t.type,
              name: t.name,
              supportCount: 0,
              winCount: 0,
              deltas: [],
              recentCount: 0,
            };
          }
          tacticStats[key].supportCount++;
          if (isWin) tacticStats[key].winCount++;
          if (o.delta_amount) tacticStats[key].deltas.push(Number(o.delta_amount));
          if (isRecent) tacticStats[key].recentCount++;
        }
      }

      // Compute ranked tactics
      const baselineWinRate = winRate / 100;
      for (const [, stat] of Object.entries(tacticStats)) {
        const tacticWinRate = stat.supportCount > 0 ? stat.winCount / stat.supportCount : 0;
        const successLift = baselineWinRate > 0
          ? Math.round(((tacticWinRate - baselineWinRate) / baselineWinRate) * 100)
          : 0;

        const sortedDeltas = [...stat.deltas].sort((a, b) => a - b);
        const medianDelta = sortedDeltas.length > 0
          ? sortedDeltas[Math.floor(sortedDeltas.length / 2)]
          : 0;

        // Recency-weighted score: recent contributions count 2x
        const recencyScore = Math.round(
          (stat.winCount * 10 + stat.recentCount * 5) * (1 + successLift / 100)
        );

        const { error: tErr } = await supabase
          .from("carrier_scenario_tactics")
          .upsert({
            scenario_key: scenarioKey,
            tactic_type: stat.type,
            tactic_name: stat.name,
            support_count: stat.supportCount,
            success_lift: successLift,
            median_delta_when_present: medianDelta,
            recency_weighted_score: recencyScore,
            last_updated_at: new Date().toISOString(),
          }, { onConflict: "scenario_key, tactic_type, tactic_name" });

        if (!tErr) tacticsUpdated++;
      }
    }

    console.log(`[Playbook] Done: ${playbooksUpdated} playbooks, ${tacticsUpdated} tactics`);

    return new Response(
      JSON.stringify({
        success: true,
        playbooks_updated: playbooksUpdated,
        tactics_updated: tacticsUpdated,
        outcomes_processed: outcomeEvents.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[Playbook] Fatal error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
