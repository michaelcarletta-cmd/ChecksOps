import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid, plaidEnv } from "../_shared/plaidClient.ts";

// Mints a Plaid Link token for a signed-in ChecksOps user linking a bank
// account they have tenant access to.

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { stakeholder_account_id } = await req.json();
    if (!stakeholder_account_id) return json({ error: "stakeholder_account_id is required" }, 400);

    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, custname, verification_status")
      .eq("id", stakeholder_account_id)
      .maybeSingle();
    if (acctErr) return json({ error: acctErr.message }, 400);
    if (!account) return json({ error: "Account not found" }, 404);

    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", account.tenant_id)
      .maybeSingle();
    if (!membership) return json({ error: "Forbidden" }, 403);

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
    });
  } catch (err: any) {
    console.error("[plaid-link-token-create]", err);
    return json({ success: false, error: err.message }, 400);
  }
});
