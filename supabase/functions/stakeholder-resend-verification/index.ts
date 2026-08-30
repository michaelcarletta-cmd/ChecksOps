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
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_token: token,
        verification_token_expires_at: expiresAt,
        verification_recipient_email: to,
      })
      .eq("id", stakeholder_account_id);

    const appBase = Deno.env.get("CHECKSOPS_APP_URL") ?? Deno.env.get("APP_BASE_URL") ?? "https://checksops.com";
    let verifyUrl = `${appBase}/verify-account/${token}`;

    // Moov is the payment rail: send the recipient to the branded Moov-backed
    // setup page (/pay-setup/:token) instead of the legacy bank-login flow.
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() === "true") {
      const moovLink = await ensureMoovRecipientLink({
        supabase,
        authHeader,
        appBase,
        tenantId: account.tenant_id,
        stakeholderAccountId: stakeholder_account_id,
        name: account.custname || account.nickname || "Payment recipient",
        email: to,
      });
      if (typeof moovLink === "object" && "error" in moovLink) {
        return new Response(JSON.stringify({ success: false, error: moovLink.error }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      verifyUrl = moovLink as string;
    }

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id,
      tenant_id: account.tenant_id,
      event_type: "resent",
      actor_user_id: userData.user.id,
      details: { recipient_email: to },
    });

    // supabase.functions.invoke() does NOT throw when the invoked function
    // returns an HTTP error — it resolves with an `error` property instead.
    // Check it explicitly so a failed send is reported back to the caller
    // rather than silently swallowed while the UI reports "success".
    let emailData: any = null;
    let emailErr: any = null;
    try {
      const res = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "stakeholder-verify-account",
          recipientEmail: to,
          tenantId: account.tenant_id,
          idempotencyKey: `verify-${stakeholder_account_id}-${token}`,
          templateData: {
            nickname: account.nickname,
            custname: account.custname,
            verifyUrl,
          },
        },
      });
      emailData = res.data;
      emailErr = res.error;
    } catch (e) {
      emailErr = e;
    }

    if (emailErr) {
      let msg = emailErr.message ?? "Failed to send verification email";
      try { const b = await emailErr.context?.json?.(); if (b?.error) msg = b.error; } catch { /* ignore */ }
      console.error("[stakeholder-resend-verification] email send failed", msg);
      return new Response(JSON.stringify({ success: false, error: msg }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (emailData?.error) {
      console.error("[stakeholder-resend-verification] email send failed", emailData.error);
      return new Response(JSON.stringify({ success: false, error: emailData.error }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[stakeholder-resend-verification]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Finds or creates the Moov recipient tied to this stakeholder account and
 * returns a fresh /pay-setup link. Returns { error } when the payee cannot be
 * set up as an external recipient (e.g. they are already a ChecksOps org).
 */
async function ensureMoovRecipientLink(args: {
  supabase: any;
  authHeader: string;
  appBase: string;
  tenantId: string;
  stakeholderAccountId: string;
  name: string;
  email: string;
}): Promise<string | { error: string }> {
  const { supabase, authHeader, appBase, tenantId, stakeholderAccountId, name, email } = args;

  let { data: recipient } = await supabase
    .from("external_payment_recipients")
    .select("id, provider_account_id, secure_token")
    .eq("stakeholder_account_id", stakeholderAccountId)
    .maybeSingle();

  if (!recipient) {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/moov-recipient-create`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        name,
        email,
        recipient_type: "individual",
        relationship: "stakeholder",
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { error: payload?.error ?? "Could not create the payment recipient." };
    }
    if (payload?.is_existing_member) {
      return {
        error:
          "This payee is already a ChecksOps organization — their existing payment account will be used, no link needed.",
      };
    }
    recipient = payload?.recipient ?? null;
    if (!recipient?.id) return { error: "Could not create the payment recipient." };

    await supabase
      .from("external_payment_recipients")
      .update({ stakeholder_account_id: stakeholderAccountId })
      .eq("id", recipient.id);
  }

  if (!recipient.provider_account_id) {
    return { error: "The payment provider account isn't ready yet. Try again in a moment." };
  }

  // Always rotate the token so an old emailed link stops working.
  const newToken = secureToken();
  const { error: tokErr } = await supabase
    .from("external_payment_recipients")
    .update({
      secure_token: newToken,
      token_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      token_used_at: null,
    })
    .eq("id", recipient.id);
  if (tokErr) return { error: tokErr.message };

  return `${appBase}/pay-setup/${newToken}`;
}
