import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { initiateAuthentecheckSession } from "../_shared/actumAuthentecheckInit.ts";

// Public endpoint — the external account holder authenticates via the
// emailed verification_token, not a ChecksOps login.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { token } = await req.json();
    if (!token) throw new Error("token is required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, nickname, custname, verification_status, verification_recipient_email, verification_token_expires_at")
      .eq("verification_token", token)
      .maybeSingle();
    if (acctErr) throw new Error(acctErr.message);
    if (!account) {
      return new Response(JSON.stringify({ success: false, error: "This verification link is invalid." }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.verification_status === "locked") {
      return new Response(JSON.stringify({ success: false, error: "This account is locked. Contact the sender for help." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.verification_status === "verified" || account.verification_status === "admin_override") {
      return new Response(JSON.stringify({ success: false, alreadyVerified: true, error: "This account is already verified." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expiresAt = account.verification_token_expires_at ? new Date(account.verification_token_expires_at) : null;
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      return new Response(JSON.stringify({ success: false, expired: true, error: "This verification link has expired. Ask the sender to resend it." }), {
        status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await initiateAuthentecheckSession(supabase, account, {
      fallbackIdentity: { email: account.verification_recipient_email },
    });

    if (!result.success) {
      return new Response(JSON.stringify({ success: false, error: result.error }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, url: result.url }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[authentecheck-init-token]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
