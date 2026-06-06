import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Generate a random amount between $0.01 and $0.99
function randomCents(): number {
  return Math.floor(Math.random() * 98) + 1; // 1 to 99 cents
}

async function callActum(endpoint: string, params: URLSearchParams): Promise<Record<string, string>> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=");
    if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { account_id } = await req.json();
    if (!account_id) throw new Error("account_id is required");

    // Load the stakeholder account
    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (acctErr || !account) throw new Error("Account not found");
    if (account.verification_status === "verified") {
      return new Response(
        JSON.stringify({ success: false, error: "Account is already verified" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const amount1Cents = randomCents();
    let amount2Cents = randomCents();
    while (amount2Cents === amount1Cents) amount2Cents = randomCents();

    // Use the tenant-specific credentials if available, otherwise fallback to env
    const { data: tenantData } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id, actum_password")
      .eq("id", account.tenant_id)
      .single();

    const parentId = tenantData?.actum_parent_id || Deno.env.get("ACTUM_PARENT_ID");
    const subId = tenantData?.actum_sub_id || Deno.env.get("ACTUM_SUB_ID");
    const pass = tenantData?.actum_password || Deno.env.get("ACTUM_PASSWORD");

    if (!parentId || !subId || !pass) {
      throw new Error("Actum credentials not configured for this tenant.");
    }

    const ACTUM_API_URL = "https://transit.actumprocessing.com/cgi-bin/process.cgi";

    // Common params for both credits
    const baseParams = new URLSearchParams({
      parentid: parentId,
      subid: subId,
      password: pass,
      action: "init",
      creditflag: "1", // This makes it an ACH credit (deposit into customer account)
      custname: account.custname,
      chk_aba: account.chk_aba,
      chk_acct: account.chk_acct,
      acct_type: account.acct_type || "C",
      initial_funding: "0",
    });

    // Credit 1
    const params1 = new URLSearchParams(baseParams);
    params1.append("amount", (amount1Cents / 100).toFixed(2));
    params1.append("mer_order_number", `VER1_${account.id.slice(0, 8)}`);
    
    // Credit 2
    const params2 = new URLSearchParams(baseParams);
    params2.append("amount", (amount2Cents / 100).toFixed(2));
    params2.append("mer_order_number", `VER2_${account.id.slice(0, 8)}`);

    console.log(`Sending micro-deposits for account ${account.id}: ${amount1Cents}¢ and ${amount2Cents}¢`);
    
    const [res1, res2] = await Promise.all([
      callActum(ACTUM_API_URL, params1),
      callActum(ACTUM_API_URL, params2),
    ]);

    if (res1.status !== "Accepted" || res2.status !== "Accepted") {
      console.error("Actum micro-deposit failed:", { res1, res2 });
      throw new Error(`Actum rejected micro-deposits: ${res1.error_msg || res2.error_msg || "Unknown error"}`);
    }

    // Record the verification
    const { data: verification, error: verErr } = await supabase
      .from("micro_deposit_verifications")
      .insert({
        tenant_id: account.tenant_id,
        stakeholder_account_id: account.id,
        initiated_by: userData.user.id,
        actum_order_id_1: res1.ordernum,
        actum_history_id_1: res1.historyid,
        actum_order_id_2: res2.ordernum,
        actum_history_id_2: res2.historyid,
        amount_1_cents: amount1Cents,
        amount_2_cents: amount2Cents,
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();

    if (verErr) throw verErr;

    // Update account status
    await supabase
      .from("stakeholder_accounts")
      .update({ verification_status: "pending" })
      .eq("id", account.id);

    return new Response(
      JSON.stringify({
        success: true,
        verification_id: verification.id,
        message: "Micro-deposits initiated successfully",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Error in actum-verify-account:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
