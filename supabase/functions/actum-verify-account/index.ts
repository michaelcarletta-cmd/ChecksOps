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
      .select("actum_parent_id, actum_sub_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password")
      .eq("id", account.tenant_id)
      .single();

    const parentId = tenantData?.actum_parent_id || Deno.env.get("ACTUM_PARENT_ID");
    const subId = tenantData?.actum_sub_id || Deno.env.get("ACTUM_SUB_ID");

    if (!parentId || !subId) {
      throw new Error("Actum credentials not configured for this tenant.");
    }

    // Ensure we use the correct Actum endpoint for manual transactions
    const ACTUM_API_URL = "https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi";

    function buildParams(amountCents: number, label: string) {
      const p = new URLSearchParams();
      p.append("parent_id", parentId!);
      p.append("sub_id", subId!);
      if ((tenantData as any)?.actum_syspass) p.append("syspass", (tenantData as any).actum_syspass);
      if ((tenantData as any)?.actum_username) p.append("api_user", (tenantData as any).actum_username);
      if ((tenantData as any)?.actum_password) p.append("api_password", (tenantData as any).actum_password);
      p.append("pmt_type", "chk");
      p.append("custname", account.custname);
      p.append("chk_acct", account.chk_acct);
      p.append("chk_aba", account.chk_aba);
      p.append("acct_type", account.acct_type || "C");
      p.append("initial_amount", (amountCents / 100).toFixed(2));
      p.append("billing_cycle", "-1");
      p.append("action_code", "P");
      p.append("creditflag", "1");
      p.append("currency", "US");
      p.append("merordernumber", `verify_${account.id}_${label}_${Date.now()}`);
      p.append("postback", "1");
      return p;
    }

    // Credit 1
    const params1 = buildParams(amount1Cents, "1");

    // Credit 2
    const params2 = buildParams(amount2Cents, "2");

    console.log(`Sending micro-deposits for account ${account.id}: ${amount1Cents}¢ and ${amount2Cents}¢`);
    
    const [res1, res2] = await Promise.all([
      callActum(ACTUM_API_URL, params1),
      callActum(ACTUM_API_URL, params2),
    ]);

    const r1ok = (res1.status ?? "").toLowerCase() === "accepted";
    const r2ok = (res2.status ?? "").toLowerCase() === "accepted";
    if (!r1ok || !r2ok) {
      console.error("Actum micro-deposit failed:", { res1, res2 });
      throw new Error(`Actum rejected micro-deposits: ${res1.reason || res1.error_msg || res2.reason || res2.error_msg || "Unknown error"}`);
    }

    // Record the verification
    const { data: verification, error: verErr } = await supabase
      .from("micro_deposit_verifications")
      .insert({
        tenant_id: account.tenant_id,
        stakeholder_account_id: account.id,
        initiated_by: userData.user.id,
        actum_order_id_1: res1.ordernum || res1.order_id || null,
        actum_history_id_1: res1.historyid || res1.history_id || null,
        actum_order_id_2: res2.ordernum || res2.order_id || null,
        actum_history_id_2: res2.historyid || res2.history_id || null,
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
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
