import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { initiateAuthentecheckSession } from "../_shared/actumAuthentecheckInit.ts";
import { callPlaid } from "../_shared/plaidClient.ts";

// Public rail dispatcher for the emailed "link your bank account" flow.
// The external account holder authenticates with the token itself, not a login.
//
// Returns either:
//   { rail: "actum", url }         -> page redirects into the hosted session
//   { rail: "plaid", link_token }  -> page mounts Plaid Link in-place
//
// Keeping the branch server-side means the public page never needs to know
// which rail a tenant is on.

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
      .select(
        "id, tenant_id, nickname, custname, verification_status, verification_recipient_email, verification_token_expires_at",
      )
      .eq("verification_token", token)
      .maybeSingle();
    if (acctErr) return json({ success: false, error: acctErr.message }, 400);
    if (!account) return json({ success: false, error: "This verification link is invalid." }, 404);

    if (account.verification_status === "locked") {
      return json(
        { success: false, error: "This account is locked. Contact the sender for help." },
        403,
      );
    }
    if (account.verification_status === "verified" || account.verification_status === "admin_override") {
      return json({ success: false, alreadyVerified: true, error: "This account is already verified." }, 400);
    }

    // Links never dead-end: auto-extend an expired token rather than rejecting.
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

    const { data: tenant } = await supabase
      .from("tenants")
      .select("payment_rail")
      .eq("id", account.tenant_id)
      .maybeSingle();

    const rail = tenant?.payment_rail === "plaid" ? "plaid" : "actum";

    if (rail === "plaid") {
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
        rail: "plaid",
        link_token: result.link_token,
        account_holder: account.custname,
      });
    }

    const result = await initiateAuthentecheckSession(supabase, account, {
      fallbackIdentity: { email: account.verification_recipient_email },
    });
    if (!result.success) return json({ success: false, rail: "actum", error: result.error }, 400);

    return json({ success: true, rail: "actum", url: result.url });
  } catch (err: any) {
    console.error("[bank-link-session]", err);
    return json({ success: false, error: err.message }, 400);
  }
});
