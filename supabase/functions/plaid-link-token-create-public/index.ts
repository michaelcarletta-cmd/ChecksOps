import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid, plaidEnv } from "../_shared/plaidClient.ts";

// Public endpoint — the external account holder (homeowner, vendor, sales rep)
// authenticates with the emailed verification_token, not a ChecksOps login.
// Mirrors actum-authentecheck-init-token, including the never-expire behavior:
// the link auto-heals its own expiry rather than dead-ending the recipient.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { token } = await req.json();
    if (!token) return json({ success: false, error: "token is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, custname, verification_status, verification_token_expires_at")
      .eq("verification_token", token)
      .maybeSingle();
    if (acctErr) return json({ success: false, error: acctErr.message }, 400);
    if (!account) {
      return json({ success: false, error: "This verification link is invalid." }, 404);
    }
    if (account.verification_status === "locked") {
      return json(
        { success: false, error: "This account is locked. Contact the sender for help." },
        403,
      );
    }
    if (account.verification_status === "verified" || account.verification_status === "admin_override") {
      return json(
        { success: false, alreadyVerified: true, error: "This account is already verified." },
        400,
      );
    }

    // Auto-heal an expired link rather than dead-ending someone who took a
    // couple of weeks to open the email.
    const expiresAt = account.verification_token_expires_at
      ? new Date(account.verification_token_expires_at)
      : null;
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("stakeholder_accounts")
        .update({ verification_token_expires_at: newExpiry })
        .eq("id", account.id);
      await supabase
        .from("homeowner_bank_link_tokens")
        .update({ expires_at: newExpiry })
        .eq("stakeholder_account_id", account.id);
    }

    const result = await callPlaid<{ link_token: string; expiration: string }>(
      "/link/token/create",
      {
        user: { client_user_id: account.id },
        client_name: "ChecksOps",
        products: ["auth"],
        country_codes: ["US"],
        language: "en",
      },
    );

    await supabase
      .from("stakeholder_accounts")
      .update({ verification_initiated_at: new Date().toISOString() })
      .eq("id", account.id);

    return json({
      success: true,
      link_token: result.link_token,
      expiration: result.expiration,
      env: plaidEnv(),
      account_holder: account.custname,
    });
  } catch (err: any) {
    console.error("[plaid-link-token-create-public]", err);
    return json({ success: false, error: err.message }, 400);
  }
});
