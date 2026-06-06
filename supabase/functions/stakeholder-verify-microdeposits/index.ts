import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ATTEMPTS = 3;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Public endpoint — uses token as auth.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { token, amount1, amount2 } = body ?? {};

    if (!token || typeof token !== "string") {
      return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const a1 = Math.round(Number(amount1) * 100);
    const a2 = Math.round(Number(amount2) * 100);
    if (!Number.isFinite(a1) || !Number.isFinite(a2) || a1 <= 0 || a2 <= 0 || a1 > 100 || a2 > 100) {
      return new Response(JSON.stringify({ error: "Invalid amounts. Enter amounts in dollars (e.g. 0.07)." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, nickname, verification_status, verification_amount_1_cents, verification_amount_2_cents, verification_attempts, verification_token_expires_at")
      .eq("verification_token", token)
      .maybeSingle();

    if (acctErr || !account) {
      return new Response(JSON.stringify({ error: "Invalid or expired link." }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (account.verification_status === "verified") {
      return new Response(JSON.stringify({ status: "verified", message: "Account already verified." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (account.verification_status === "locked") {
      return new Response(JSON.stringify({ error: "This account is locked due to too many incorrect attempts. Please contact support." }), { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!account.verification_token_expires_at || new Date(account.verification_token_expires_at).getTime() < Date.now()) {
      await supabase.from("stakeholder_account_verification_log").insert({
        stakeholder_account_id: account.id,
        tenant_id: account.tenant_id,
        event_type: "expired",
      });
      return new Response(JSON.stringify({ error: "This verification link has expired. Please request a new one." }), { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const expected1 = account.verification_amount_1_cents;
    const expected2 = account.verification_amount_2_cents;

    // Allow either order
    const match =
      (a1 === expected1 && a2 === expected2) ||
      (a1 === expected2 && a2 === expected1);

    if (match) {
      await supabase
        .from("stakeholder_accounts")
        .update({
          verification_status: "verified",
          verification_completed_at: new Date().toISOString(),
          verification_token: null,
          verification_amount_1_cents: null,
          verification_amount_2_cents: null,
        })
        .eq("id", account.id);

      await supabase.from("stakeholder_account_verification_log").insert({
        stakeholder_account_id: account.id,
        tenant_id: account.tenant_id,
        event_type: "attempt_success",
      });

      return new Response(JSON.stringify({ status: "verified", nickname: account.nickname }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const newAttempts = (account.verification_attempts ?? 0) + 1;
    const locked = newAttempts >= MAX_ATTEMPTS;

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_attempts: newAttempts,
        verification_status: locked ? "locked" : "pending",
        verification_failure_reason: locked ? "Too many incorrect attempts" : null,
      })
      .eq("id", account.id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id: account.id,
      tenant_id: account.tenant_id,
      event_type: locked ? "locked" : "attempt_failed",
      details: { attempt: newAttempts },
    });

    if (locked) {
      return new Response(JSON.stringify({ error: "Account locked after 3 incorrect attempts. Contact support to reset." }), { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const remaining = MAX_ATTEMPTS - newAttempts;
    return new Response(JSON.stringify({ error: `Amounts don't match. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err: any) {
    console.error("[stakeholder-verify-microdeposits]", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
