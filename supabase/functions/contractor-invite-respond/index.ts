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
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { invite_id, decision } = await req.json();
    if (!invite_id || !["accepted", "declined"].includes(decision)) {
      return new Response(JSON.stringify({ error: "invite_id and decision required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load invite under caller's RLS
    const { data: invite, error: invErr } = await supabase
      .from("contractor_claim_invites")
      .select("id, contractor_id, claim_id, status")
      .eq("id", invite_id)
      .maybeSingle();
    if (invErr || !invite) {
      return new Response(JSON.stringify({ error: "invite not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (invite.status !== "pending") {
      return new Response(JSON.stringify({ error: `invite already ${invite.status}` }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller is the contractor
    const { data: profile } = await supabase
      .from("contractor_profiles")
      .select("user_id")
      .eq("id", invite.contractor_id)
      .maybeSingle();
    if (!profile || profile.user_id !== userData.user.id) {
      return new Response(JSON.stringify({ error: "only the invited contractor can respond" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: updErr } = await supabase
      .from("contractor_claim_invites")
      .update({ status: decision, responded_at: new Date().toISOString() })
      .eq("id", invite_id);
    if (updErr) throw updErr;

    if (decision === "accepted") {
      // Use service role to insert claim_contractors (bypasses staff/admin-only policy)
      const { error: ccErr } = await admin
        .from("claim_contractors")
        .upsert(
          { claim_id: invite.claim_id, contractor_id: profile.user_id },
          { onConflict: "claim_id,contractor_id", ignoreDuplicates: true },
        );
      if (ccErr) throw ccErr;
    }

    return new Response(JSON.stringify({ ok: true, status: decision }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
