/**
 * Rule Learning Orchestrator — manual/scheduled trigger to discover and
 * activate learned rule candidates.
 *
 * Modes:
 *   POST { mode: "claim", claimId }          → discover for one claim
 *   POST { mode: "global", limit?, sinceDays? } → discover across many claims
 *   POST { mode: "activate" }                → activate approved candidates
 *   POST { mode: "full", limit? }            → discover global + activate
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  discoverRuleCandidatesForClaim,
  discoverGlobalRuleCandidates,
  activateApprovedRules,
} from "../_shared/ai/ruleLearningEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "full";

    let result: Record<string, unknown> = { mode };

    if (mode === "claim") {
      if (!body.claimId) {
        return new Response(JSON.stringify({ error: "claimId required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      result = { ...result, ...(await discoverRuleCandidatesForClaim(body.claimId, supabase)) };
    } else if (mode === "global") {
      result = { ...result, ...(await discoverGlobalRuleCandidates(supabase, { limit: body.limit, sinceDays: body.sinceDays })) };
    } else if (mode === "activate") {
      result = { ...result, ...(await activateApprovedRules(supabase)) };
    } else if (mode === "full") {
      const discover = await discoverGlobalRuleCandidates(supabase, { limit: body.limit ?? 50 });
      const activate = await activateApprovedRules(supabase);
      result = { ...result, discover, activate };
    } else {
      return new Response(JSON.stringify({ error: `Unknown mode: ${mode}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[rule-learning-orchestrator] error:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
