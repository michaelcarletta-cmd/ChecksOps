import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { stakeholder_account_id, recipient_email } = await req.json();
    if (!stakeholder_account_id) throw new Error("stakeholder_account_id is required");

    const { data: account } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, nickname, custname, verification_status, verification_recipient_email")
      .eq("id", stakeholder_account_id)
      .single();
    if (!account) throw new Error("Account not found");

    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", account.tenant_id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (["verified", "admin_override", "locked"].includes(account.verification_status)) {
      return new Response(JSON.stringify({ error: `Cannot send verification link — account status is ${account.verification_status}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const to = recipient_email ?? account.verification_recipient_email;
    if (!to) throw new Error("No recipient email on file");

    // Rotate token + extend expiry
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_token: token,
        verification_token_expires_at: expiresAt,
        verification_recipient_email: to,
      })
      .eq("id", stakeholder_account_id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id,
      tenant_id: account.tenant_id,
      event_type: "resent",
      actor_user_id: userData.user.id,
      details: { recipient_email: to },
    });

    try {
      await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "stakeholder-verify-account",
          recipientEmail: to,
          tenantId: account.tenant_id,
          idempotencyKey: `verify-${stakeholder_account_id}-${token}`,
          templateData: {
            nickname: account.nickname,
            custname: account.custname,
            verifyUrl: `${Deno.env.get("APP_BASE_URL") ?? "https://checksops.com"}/verify-account/${token}`,
          },
        },
      });
    } catch (e) {
      console.error("[stakeholder-resend-verification] email enqueue failed", e);
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[stakeholder-resend-verification]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
