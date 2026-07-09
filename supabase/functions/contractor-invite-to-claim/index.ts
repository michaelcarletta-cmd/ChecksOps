import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const { contractor_id, claim_id, message } = await req.json();
    if (!contractor_id || !claim_id) {
      return new Response(JSON.stringify({ error: "contractor_id and claim_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve org_id from claim
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("id, org_id")
      .eq("id", claim_id)
      .maybeSingle();
    if (claimErr || !claim?.org_id) {
      return new Response(JSON.stringify({ error: "claim not accessible" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Reuse existing pending invite if any
    const { data: existing } = await supabase
      .from("contractor_claim_invites")
      .select("id, status")
      .eq("contractor_id", contractor_id)
      .eq("claim_id", claim_id)
      .eq("status", "pending")
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ invite_id: existing.id, reused: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invite, error: insErr } = await supabase
      .from("contractor_claim_invites")
      .insert({
        contractor_id,
        org_id: claim.org_id,
        claim_id,
        invited_by: userId,
        message: message ?? null,
      })
      .select("id")
      .single();

    if (insErr) throw insErr;

    return new Response(JSON.stringify({ invite_id: invite.id, reused: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
