import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isValidRoutingNumber(aba: string): boolean {
  const clean = (aba ?? "").replace(/\D/g, "");
  return clean.length === 9;
}

function randCents(): number {
  // 1..25 inclusive
  return 1 + Math.floor(Math.random() * 25);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    console.log("[stakeholder-init-microdeposits] starting request...");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.error("[stakeholder-init-microdeposits] missing or invalid auth header");
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      console.error("[stakeholder-init-microdeposits] auth error:", userErr);
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    console.log("[stakeholder-init-microdeposits] user authenticated:", userData.user.id);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { stakeholder_account_id, recipient_email } = body ?? {};
    if (!stakeholder_account_id) throw new Error("stakeholder_account_id is required");
    if (!recipient_email || !/^\S+@\S+\.\S+$/.test(recipient_email)) {
      throw new Error("Valid recipient_email is required");
    }

    // Load account + verify caller has tenant access
    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, nickname, chk_aba, chk_acct, acct_type, custname, consumer_unique, verification_status")
      .eq("id", stakeholder_account_id)
      .single();
    if (acctErr || !account) throw new Error("Account not found");

    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", account.tenant_id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (account.verification_status === "verified") {
      return new Response(JSON.stringify({ error: "Account is already verified" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (account.verification_status === "locked") {
      return new Response(JSON.stringify({ error: "Account is locked. Reset it and re-add to retry." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!isValidRoutingNumber(account.chk_aba)) {
      return new Response(JSON.stringify({ error: "Routing number failed checksum. Please correct it." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const amount1 = randCents();
    let amount2 = randCents();
    while (amount2 === amount1) amount2 = randCents();

    // Load tenant Actum creds
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id, actum_syspass, actum_username, actum_password")
      .eq("id", account.tenant_id)
      .single();
    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const actumParentId = tenantData?.actum_parent_id || Deno.env.get("ACTUM_PARENT_ID");
    const actumSubId = tenantData?.actum_sub_id || Deno.env.get("ACTUM_SUB_ID");
    if (!actumParentId || !actumSubId) {
      throw new Error("Actum credentials not configured for this tenant.");
    }
    const actumEndpoint = "https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi";

    async function sendOne(amountCents: number, label: string) {
      const params = new URLSearchParams();
      params.append("parent_id", actumParentId!);
      params.append("sub_id", actumSubId!);
      if ((tenantData as any)?.actum_syspass) params.append("syspass", (tenantData as any).actum_syspass);
      if ((tenantData as any)?.actum_username) params.append("api_user", (tenantData as any).actum_username);
      if ((tenantData as any)?.actum_password) params.append("api_password", (tenantData as any).actum_password);
      params.append("pmt_type", "chk");
      params.append("custname", account.custname);
      params.append("chk_acct", account.chk_acct);
      params.append("chk_aba", account.chk_aba);
      params.append("acct_type", account.acct_type);
      params.append("initial_amount", (amountCents / 100).toFixed(2));
      params.append("billing_cycle", "-1");
      params.append("action_code", "P");
      params.append("creditflag", "1");
      params.append("currency", "US");
      params.append("merordernumber", `v1_${stakeholder_account_id.slice(0, 8)}_${Date.now()}`);
      params.append("postback", "1");
      params.append("idempotence", `v1_${stakeholder_account_id.slice(0, 8)}_${Date.now()}`);

      console.log(`[stakeholder-init-microdeposits] sending micro-deposit to Actum for ${account.id} (${label}): ${amountCents}c`);
      const res = await fetch(actumEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const text = await res.text();
      console.log(`[stakeholder-init-microdeposits] Actum response for ${account.id} (${label}):`, text);
      const parsed: Record<string, string> = {};
      for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const eq = line.indexOf("=");
        if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const accepted = (parsed.status ?? "").toLowerCase() === "accepted";
      return { accepted, parsed };
    }

    const r1 = await sendOne(amount1, "1");
    if (!r1.accepted) {
      return new Response(JSON.stringify({ error: `Bank network rejected first micro-deposit: ${r1.parsed.reason ?? r1.parsed.authcode ?? "declined"}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const r2 = await sendOne(amount2, "2");
    if (!r2.accepted) {
      return new Response(JSON.stringify({ error: `Bank network rejected second micro-deposit: ${r2.parsed.reason ?? r2.parsed.authcode ?? "declined"}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Capture consumer_unique if returned
    const consumerUnique = r1.parsed.consumer_unique || r2.parsed.consumer_unique || null;

    // Generate token + expiry (14 days)
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_status: "pending",
        verification_initiated_at: new Date().toISOString(),
        verification_completed_at: null,
        verification_amount_1_cents: amount1,
        verification_amount_2_cents: amount2,
        verification_attempts: 0,
        verification_token: token,
        verification_token_expires_at: expiresAt,
        verification_failure_reason: null,
        verification_recipient_email: recipient_email,
        ...(consumerUnique ? { consumer_unique: consumerUnique } : {}),
      })
      .eq("id", stakeholder_account_id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id,
      tenant_id: account.tenant_id,
      event_type: "initiated",
      actor_user_id: userData.user.id,
      details: { recipient_email, expires_at: expiresAt },
    });

    // Enqueue verification email (best-effort — don't fail init if email enqueue fails)
    try {
      await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "stakeholder-verify-account",
          recipientEmail: recipient_email,
          idempotencyKey: `verify-${stakeholder_account_id}-${token}`,
          templateData: {
            nickname: account.nickname,
            custname: account.custname,
            lastFour: String(account.chk_acct).slice(-4),
            verifyUrl: `${Deno.env.get("APP_BASE_URL") ?? "https://checksops.com"}/verify-account/${token}`,
          },
        },
      });
    } catch (e) {
      console.error("[stakeholder-init-microdeposits] email enqueue failed", e);
    }

    return new Response(
      JSON.stringify({ success: true, status: "pending", token_expires_at: expiresAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[stakeholder-init-microdeposits]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
