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
      .select("actum_environment, actum_parent_id, actum_sub_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password, actum_test_parent_id, actum_test_sub_id_ppd, actum_test_sub_id_ccd, actum_test_syspass, actum_test_username, actum_test_password")
      .eq("id", account.tenant_id)
      .single();
    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const env = (tenantData as any)?.actum_environment === "production" ? "production" : "test";
    const isProd = env === "production";
    const syspass = isProd ? tenantData?.actum_syspass : (tenantData as any)?.actum_test_syspass;
    const meruser = isProd ? tenantData?.actum_username : (tenantData as any)?.actum_test_username;
    const merpass = isProd ? tenantData?.actum_password : (tenantData as any)?.actum_test_password;
    const parentId = isProd ? (tenantData as any)?.actum_parent_id : (tenantData as any)?.actum_test_parent_id;
    const subid = isProd
      ? ((tenantData as any)?.actum_sub_id_ppd || (tenantData as any)?.actum_sub_id_ccd || (tenantData as any)?.actum_sub_id)
      : ((tenantData as any)?.actum_test_sub_id_ppd || (tenantData as any)?.actum_test_sub_id_ccd);
    if (!meruser || !merpass || !syspass || !parentId || !subid) {
      throw new Error(`Actum Authentecheck ${env} credentials not configured for this tenant.`);
    }
    console.log(`[authentecheck-init] using ${env} environment for tenant ${account.tenant_id}`);

    // Pull consumer name/email — first from account, fall back to signed-in user's profile.
    const { data: profile } = await supabase
      .from("profiles")
      .select("first_name, last_name, email, full_name")
      .eq("id", userData.user.id)
      .maybeSingle();

    // Actum rejects names containing "@" or other non-name chars ("First name
    // foo@bar.com is invalid"). Sanitize each candidate: drop empties, drop
    // anything that looks like an email, strip disallowed characters. Only
    // fall through to the signed-in user's email as a *last resort*, and even
    // then use the local-part with punctuation stripped.
    const cleanNamePart = (s: string) =>
      s.replace(/[^A-Za-z' -]/g, "").trim();
    const isEmailish = (s: string) => /@/.test(s);
    const nameCandidates: string[] = [];
    if (account.custname && account.custname !== "Pending" && !isEmailish(account.custname)) {
      nameCandidates.push(account.custname);
    }
    const joinedProfile = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ");
    if (joinedProfile && !isEmailish(joinedProfile)) nameCandidates.push(joinedProfile);
    if (profile?.full_name && !isEmailish(profile.full_name)) nameCandidates.push(profile.full_name);
    // Last resort: derive from email local-part (e.g. "mcarletta@..." -> "Mcarletta Holder")
    const emailLocal = (userData.user.email ?? "").split("@")[0]?.replace(/[._-]+/g, " ").trim();
    if (emailLocal) nameCandidates.push(emailLocal.charAt(0).toUpperCase() + emailLocal.slice(1));
    nameCandidates.push("Account Holder");

    const rawName = nameCandidates.find((n) => cleanNamePart(n).length > 0) ?? "Account Holder";
    const parts = cleanNamePart(rawName).split(/\s+/).filter(Boolean);
    // In test/sandbox mode, Plaid's test institutions (Houndstooth Bank, First
    // Platypus Bank) always return a fixed identity ("Robert A Yakuza"). Actum
    // appears to cross-check the merchant-submitted name against the identity
    // Plaid returns, so submitting a real user's name here causes a mismatch
    // that a real production bank login wouldn't hit. Match Actum's own
    // documented test identity instead of the signed-in user's real name.
    const firstName = isProd ? (parts[0] || "Account").slice(0, 30) : "Bob";
    const lastName = isProd ? (parts.length > 1 ? parts.slice(1).join(" ") : "Holder").slice(0, 30) : "Yakuza";


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

    // Per Actum's working curl example: the merchant token goes in the URL
    // query string as `?chk:PARENT:SUB=null` (URL-encoded colons), NOT in the
    // POST body. All other fields are standard form-urlencoded body params.
    // Also required: `authdata=1` and `identity=1` to trigger the Plaid-backed
    // Authentecheck flow (bank verification), not a regular signup charge.
    const psDesc = `Bank verification ${(account.nickname ?? "Account").slice(0, 20)}`
      .replace(/[^A-Za-z0-9 ]/g, "")
      .slice(0, 50);

    const params = new URLSearchParams();
    params.append("custemail", custEmail);
    params.append("firstname", firstName);
    params.append("lastname", lastName);
    // Actum: "$0 will return ACH Verification" — Authentecheck is a bank-account
    // verification session, not a real charge, so the initial amount is $0.
    params.append("ps1_init", "0.00");
    params.append("ps1_cycle", "-1");
    params.append("ps1_desc", psDesc);
    params.append("merchantdata", account.id);
    params.append("redirect_accept", acceptUrl);
    params.append("redirect_decline", declineUrl);
    params.append("dynamic_saleurl", postbackUrl);
    params.append("authdata", "1");
    params.append("identity", "1");
    // Actum enabled the "verifiedcons" bypass for this account — without it, a
    // consumer's first transaction is held for two business days and any
    // repeat attempt with the same routing/account (e.g. repeated sandbox
    // testing with the same test bank account) is declined as "Uncleared
    // Transaction" during Transaction Processing.
    params.append("verifiedcons", "1");
    // Per Actum support: their stored/default postback URL is only actually
    // triggered when postback=1 is included in the request, in addition to
    // (or alongside) dynamic_saleurl.
    params.append("postback", "1");
    params.append("meruser", meruser);
    params.append("merpass", merpass);
    params.append("syspass", syspass);

    const parentClean = String(parentId).trim();
    const subClean = String(subid).trim();
    // Encode the colons in the merchant token key (Actum's example uses %3A).
    const merchantTokenParam = `chk%3A${encodeURIComponent(parentClean)}%3A${encodeURIComponent(subClean)}=null`;
    const url = `${SIGNUP_INIT}?${merchantTokenParam}`;

    console.log("[authentecheck-init] initiating session for account", account.id, "url:", url);
    const res = await fetch(url, {
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
