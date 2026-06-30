import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIGNUP_INIT = "https://join.actumprocessing.com/Signup/SignupInit.cgi";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let failedAccount: { id: string; tenant_id: string } | null = null;

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
    failedAccount = { id: account.id, tenant_id: account.tenant_id };

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

    // Load tenant Actum creds (env-aware)
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_environment, actum_syspass, actum_username, actum_password, actum_test_syspass, actum_test_username, actum_test_password")
      .eq("id", account.tenant_id)
      .single();
    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const env = (tenantData as any)?.actum_environment === "production" ? "production" : "test";
    const isProd = env === "production";
    const syspass = isProd ? tenantData?.actum_syspass : (tenantData as any)?.actum_test_syspass;
    const meruser = isProd ? tenantData?.actum_username : (tenantData as any)?.actum_test_username;
    const merpass = isProd ? tenantData?.actum_password : (tenantData as any)?.actum_test_password;
    if (!meruser || !merpass || !syspass) {
      throw new Error(`Actum Authentecheck ${env} credentials not configured for this tenant.`);
    }
    console.log(`[authentecheck-init] using ${env} environment for tenant ${account.tenant_id}`);

    // Pull consumer name/email — first from account, fall back to signed-in user's profile.
    const { data: profile } = await supabase
      .from("profiles")
      .select("first_name, last_name, email, full_name")
      .eq("id", userData.user.id)
      .maybeSingle();

    const rawName =
      (account.custname && account.custname !== "Pending" ? account.custname : "")
      || [profile?.first_name, profile?.last_name].filter(Boolean).join(" ")
      || profile?.full_name
      || userData.user.email
      || "Account Holder";
    const parts = String(rawName).trim().split(/\s+/);
    const firstName = (parts[0] ?? "Account").slice(0, 30);
    const lastName = (parts.length > 1 ? parts.slice(1).join(" ") : "Holder").slice(0, 30);

    const emailCandidate = String(
      account.verification_recipient_email
      || profile?.email
      || userData.user.email
      || ""
    ).trim();
    const custEmail = emailCandidate && emailCandidate.length <= 50
      ? emailCandidate
      : `bank-${account.id.slice(0, 8)}@checksops.com`;

    const appBase = Deno.env.get("APP_BASE_URL") ?? "https://checksops.com";
    const acceptUrl = return_url ?? `${appBase}/verify-account/complete?ok=1&acct=${account.id}`;
    const declineUrl = return_url ?? `${appBase}/verify-account/complete?ok=0&acct=${account.id}`;
    const postbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/actum-authentecheck-postback`;

    // Per Actum Authentecheck docs (SignupInit.cgi), the merchant token is a
    // bare first segment (`chk:actum:<subid>`), followed by normal form fields.
    // Do not URL-encode that first token or send it as pmt_type/key=value —
    // Actum's SignupInit parser rejects those variants as malformed PostData.
    const subid = meruser;
    const psDesc = `Bank verification ${(account.nickname ?? "Account").slice(0, 20)}`
      .replace(/[^A-Za-z0-9 ]/g, "")
      .slice(0, 50);

    const params = new URLSearchParams();
    params.append("custemail", custEmail);
    params.append("firstname", firstName);
    params.append("lastname", lastName);
    params.append("ps1_init", "1.00");
    params.append("ps1_desc", psDesc);
    params.append("merchantdata", account.id);
    params.append("redirect_accept", acceptUrl);
    params.append("redirect_decline", declineUrl);
    params.append("dynamic_saleurl", postbackUrl);
    params.append("meruser", meruser);
    params.append("merpass", merpass);
    params.append("syspass", syspass);
    const postData = `chk:actum:${subid}&${params.toString()}`;

    console.log("[authentecheck-init] initiating session for account", account.id);
    const res = await fetch(SIGNUP_INIT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: postData,
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
    if (failedAccount) {
      await createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      )
        .from("stakeholder_accounts")
        .update({
          is_active: false,
          verification_status: "failed",
          verification_failure_reason: err.message ?? "Authentecheck failed to start",
        })
        .eq("id", failedAccount.id);
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
