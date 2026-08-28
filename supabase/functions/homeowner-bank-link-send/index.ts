// Send a homeowner an AuthenteCheck bank-verification link.
// Creates a shell stakeholder_accounts row (origin='homeowner_link') + a
// homeowner_bank_link_tokens row scoped to a check or the whole claim, then
// emails the homeowner the existing /verify-account/:token link. When they
// finish verification, the DB trigger auto-attaches the account as a
// stakeholder on the target check(s). No changes to the AuthenteCheck flow.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const {
      tenant_id,
      scope,                     // 'check' | 'claim'
      check_intake_item_id,      // required when scope='check'
      claim_id,                  // required when scope='claim'
      homeowner_name,
      homeowner_email,
    } = await req.json();

    if (!tenant_id) throw new Error("tenant_id is required");
    if (!["check", "claim"].includes(scope)) throw new Error("scope must be 'check' or 'claim'");
    if (scope === "check" && !check_intake_item_id) throw new Error("check_intake_item_id is required for check scope");
    if (scope === "claim" && !claim_id) throw new Error("claim_id is required for claim scope");
    if (!homeowner_name || !homeowner_email) throw new Error("homeowner_name and homeowner_email are required");

    // Verify sender belongs to tenant
    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // If scope='check', confirm the check belongs to (or is shared with) this tenant
    if (scope === "check") {
      const { data: chk } = await supabase
        .from("check_intake_items")
        .select("id, tenant_id, claim_id")
        .eq("id", check_intake_item_id)
        .maybeSingle();
      if (!chk) throw new Error("Check not found");
      if (chk.tenant_id !== tenant_id) {
        // allow if shared to this tenant
        const { data: share } = await supabase
          .from("shared_checks")
          .select("id")
          .eq("check_id", check_intake_item_id)
          .eq("target_tenant_id", tenant_id)
          .is("revoked_at", null)
          .maybeSingle();
        if (!share) throw new Error("Check not accessible");
      }

      // Enforce ONE homeowner AuthenteCheck per check file.
      // Reject if there's already a non-expired link OR a homeowner stakeholder
      // already attached to this check.
      const nowIso = new Date().toISOString();
      const { data: existingLink } = await supabase
        .from("homeowner_bank_link_tokens")
        .select("id, status, expires_at")
        .eq("check_intake_item_id", check_intake_item_id)
        .neq("status", "expired")
        .neq("status", "revoked")
        .gte("expires_at", nowIso)
        .maybeSingle();
      if (existingLink) {
        return new Response(JSON.stringify({
          error: "A homeowner bank-link has already been sent for this check. Only one homeowner AuthenteCheck is allowed per check file.",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { data: existingHomeownerStakeholder } = await supabase
        .from("check_stakeholders")
        .select("id, stakeholder_account_id, stakeholder_accounts!inner(account_type)")
        .eq("check_intake_item_id", check_intake_item_id)
        .eq("stakeholder_accounts.account_type", "homeowner")
        .maybeSingle();
      if (existingHomeownerStakeholder) {
        return new Response(JSON.stringify({
          error: "A homeowner is already linked to this check. Only one homeowner AuthenteCheck is allowed per check file.",
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const verificationToken = crypto.randomUUID();
    // Homeowner-facing bank link: give them plenty of time to open it. Actum's
    // AuthenteCheck session (short-lived) is minted lazily when they click, so
    // this expiry only gates our wrapper URL. 30 days keeps casual delays from
    // turning into "expired link" support tickets.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();


    // 1. Create shell stakeholder_accounts row
    const nickname = `Homeowner: ${homeowner_name}`;
    const { data: account, error: acctErr } = await supabase
      .from("stakeholder_accounts")
      .insert({
        tenant_id,
        created_by: userData.user.id,
        nickname,
        account_type: "homeowner",
        chk_aba: "000000000",         // placeholders — AuthenteCheck fills in on postback
        chk_acct: "PENDING",
        acct_type: "C",
        custname: homeowner_name,
        is_primary: false,
        is_active: true,
        origin: "homeowner_link",
        homeowner_email,
        homeowner_name,
        verification_status: "unverified",
        verification_token: verificationToken,
        verification_token_expires_at: expiresAt,
        verification_recipient_email: homeowner_email,
      })
      .select("id, tenant_id, nickname, custname")
      .single();
    if (acctErr) throw new Error(`Failed to create stakeholder shell: ${acctErr.message}`);

    // 2. Create link token row + link back to account
    const linkToken = crypto.randomUUID();
    const { data: linkRow, error: linkErr } = await supabase
      .from("homeowner_bank_link_tokens")
      .insert({
        tenant_id,
        sent_by_user_id: userData.user.id,
        scope,
        check_intake_item_id: scope === "check" ? check_intake_item_id : null,
        claim_id: scope === "claim" ? claim_id : (null),
        homeowner_name,
        homeowner_email,
        token: linkToken,
        status: "sent",
        stakeholder_account_id: account.id,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (linkErr) throw new Error(`Failed to create link token: ${linkErr.message}`);

    await supabase.from("stakeholder_accounts")
      .update({ homeowner_link_token_id: linkRow.id })
      .eq("id", account.id);

    // 2b. Immediately attach the homeowner as a stakeholder on the target
    // check(s), so the disbursement console shows them right away with an
    // "Awaiting verification" badge. Once AuthenteCheck completes, the
    // account flips to verified and disbursement is unblocked — no need to
    // wait for the postback to make them visible.
    if (scope === "check") {
      await supabase.from("check_stakeholders").insert({
        check_intake_item_id,
        stakeholder_account_id: account.id,
        tenant_id,
        added_via: "homeowner_link",
        added_by: userData.user.id,
      });
    } else if (scope === "claim") {
      const { data: claimChecks } = await supabase
        .from("check_intake_items")
        .select("id")
        .eq("claim_id", claim_id);
      if (claimChecks?.length) {
        await supabase.from("check_stakeholders").insert(
          claimChecks.map((c: any) => ({
            check_intake_item_id: c.id,
            stakeholder_account_id: account.id,
            tenant_id,
            added_via: "homeowner_link",
            added_by: userData.user.id,
          })),
        );
      }
    }

    // 2c. Moov path — when this tenant is set up with the Moov rail, mint a
    // provider recipient for the homeowner so their bank details are collected
    // by Moov's hosted form and funds can be sent on the same rail the tenant
    // disburses with. Falls back silently to the AuthenteCheck link if Moov
    // isn't configured for this tenant.
    let payoutUrl: string | null = null;
    try {
      const { data: providerAcct } = await supabase
        .from("payment_provider_accounts")
        .select("id, provider, can_send_payments, disabled")
        .eq("tenant_id", tenant_id)
        .eq("provider", "moov")
        .maybeSingle();

      if (providerAcct && !providerAcct.disabled) {
        const { data: rec, error: recErr } = await authClient.functions.invoke("moov-recipient-create", {
          body: {
            tenant_id,
            name: homeowner_name,
            email: homeowner_email,
            recipient_type: "individual",
            relationship: "homeowner",
            claim_id: scope === "claim" ? claim_id : null,
            check_id: scope === "check" ? check_intake_item_id : null,
            expires_in_days: 30,
          },
        });
        if (recErr) throw recErr;
        const recipient = (rec as any)?.recipient;
        if (recipient?.provider_account_id) {
          payoutUrl = (rec as any).secure_link ?? null;
          await supabase
            .from("stakeholder_accounts")
            .update({
              provider: "moov",
              provider_environment: recipient.environment ?? null,
              provider_account_id: recipient.provider_account_id,
              verification_source: "moov",
              verification_status: "pending",
            })
            .eq("id", account.id);
        }
      }
    } catch (e) {
      console.error("[homeowner-bank-link-send] moov recipient setup skipped:", (e as Error).message);
    }


    // 3. Email the homeowner via the existing verify-account template
    let emailErr: any = null;
    try {
      const res = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "stakeholder-verify-account",
          recipientEmail: homeowner_email,
          tenantId: tenant_id,
          idempotencyKey: `homeowner-bank-link-${linkRow.id}`,
          templateData: {
            nickname,
            custname: homeowner_name,
            verifyUrl: `${Deno.env.get("APP_BASE_URL") ?? "https://checksops.com"}/verify-account/${verificationToken}`,
          },
        },
      });
      emailErr = res.error ?? (res.data?.error ? new Error(res.data.error) : null);
    } catch (e) { emailErr = e; }

    if (emailErr) {
      const msg = emailErr.message ?? "Failed to send email";
      console.error("[homeowner-bank-link-send] email failed", msg);
      return new Response(JSON.stringify({ success: false, error: msg }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      link_token_id: linkRow.id,
      stakeholder_account_id: account.id,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("[homeowner-bank-link-send]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
