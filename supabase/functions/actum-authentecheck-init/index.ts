import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIGNUP_INIT = "https://join.actumprocessing.com/Signup/SignupInit.cgi";

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

    const { stakeholder_account_id, return_url } = await req.json();
    if (!stakeholder_account_id) throw new Error("stakeholder_account_id is required");

    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, nickname, custname, account_type, verification_status, verification_recipient_email")
      .eq("id", stakeholder_account_id)
      .single();
    if (acctErr || !account) throw new Error("Account not found");

    // Tenant access check
    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", account.tenant_id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.verification_status === "verified" || account.verification_status === "admin_override") {
      return new Response(JSON.stringify({ error: "Account is already verified" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load tenant Actum creds
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password")
      .eq("id", account.tenant_id)
      .single();
    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const subId = account.account_type === "insured"
      ? tenantData?.actum_sub_id_ppd
      : tenantData?.actum_sub_id_ccd;
    const parentId = tenantData?.actum_parent_id || "ACTUM";
    if (!tenantData?.actum_username || !tenantData?.actum_password || !tenantData?.actum_syspass || !subId) {
      throw new Error("Actum Authentecheck credentials not configured for this tenant.");
    }

    // Parse first/last name from custname
    const fullName = (account.custname ?? "Account Holder").trim();
    const parts = fullName.split(/\s+/);
    const firstName = parts[0] ?? "Account";
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "Holder";
    const custEmail = account.verification_recipient_email || `noreply+${account.id}@checksops.com`;

    const appBase = Deno.env.get("APP_BASE_URL") ?? "https://checksops.com";
    const acceptUrl = return_url ?? `${appBase}/verify-account/complete?ok=1&acct=${account.id}`;
    const declineUrl = return_url ?? `${appBase}/verify-account/complete?ok=0&acct=${account.id}`;
    const postbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/actum-authentecheck-postback`;

    // Actum SignupInit expects pmt_type as "chk:<PARENT_ID>:<SUB_ID>", NOT a separate sub_id field.
    // custemail is required. ps1_maxnb is only meaningful with recurring cycles, omit for one-time.
    const params = new URLSearchParams();
    params.append("meruser", tenantData.actum_username);
    params.append("merpass", tenantData.actum_password);
    params.append("syspass", tenantData.actum_syspass);
    params.append("pmt_type", `chk:${parentId}:${subId}`);
    params.append("firstname", firstName);
    params.append("lastname", lastName);
    params.append("custemail", custEmail);
    params.append("ps1_init", "0.01");
    params.append("ps1_desc", `Bank verification - ${account.nickname ?? "Account"}`.slice(0, 50));
    params.append("ps1_cycle", "-1");
    params.append("authdata", "1");
    params.append("identity", "1");
    params.append("merchantdata", account.id);
    params.append("redirect_accept", acceptUrl);
    params.append("redirect_decline", declineUrl);
    params.append("dynamic_saleurl", postbackUrl);

    console.log("[authentecheck-init] initiating session for account", account.id);
    const res = await fetch(SIGNUP_INIT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = await res.text();
    console.log("[authentecheck-init] Actum response:", text);

    // Parse single key=value
    let sessionUrl: string | null = null;
    let actumErr: string | null = null;
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === "url") sessionUrl = v;
      if (k === "error") actumErr = v;
    }

    if (!sessionUrl) {
      throw new Error(actumErr ?? `Actum did not return a session URL: ${text.slice(0, 200)}`);
    }

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_status: "pending",
        authentecheck_session_url: sessionUrl,
        authentecheck_initiated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id: account.id,
      tenant_id: account.tenant_id,
      event_type: "authentecheck_initiated",
      actor_user_id: userData.user.id,
      details: { session_url: sessionUrl },
    });

    return new Response(
      JSON.stringify({ success: true, url: sessionUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[authentecheck-init]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
