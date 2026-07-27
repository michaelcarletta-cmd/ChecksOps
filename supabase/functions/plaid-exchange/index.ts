import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid, acctTypeFromPlaid } from "../_shared/plaidClient.ts";

// Finalizes a Plaid Link session: exchanges the public_token, pulls real
// routing/account numbers via /auth/get and the holder name via /identity/get,
// then writes the same columns the Authentecheck postback writes so the rest of
// the app (disbursement, payroll, funds tab) needs no changes.
//
// Accepts EITHER:
//   - a signed-in ChecksOps user + stakeholder_account_id, or
//   - a `token` (the emailed verification_token) for external account holders.

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let accountId: string | null = null;

  try {
    const { public_token, stakeholder_account_id, token, account_id } = await req.json();
    if (!public_token) return json({ success: false, error: "public_token is required" }, 400);

    // ---- Resolve + authorize the target account -------------------------
    let account: any = null;

    if (token) {
      const { data } = await supabase
        .from("stakeholder_accounts")
        .select("id, tenant_id, nickname, custname, verification_status")
        .eq("verification_token", token)
        .maybeSingle();
      account = data;
      if (!account) return json({ success: false, error: "This verification link is invalid." }, 404);
      if (account.verification_status === "locked") {
        return json({ success: false, error: "This account is locked." }, 403);
      }
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: userData, error: userErr } = await authClient.auth.getUser();
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

      if (!stakeholder_account_id) {
        return json({ success: false, error: "stakeholder_account_id is required" }, 400);
      }
      const { data } = await supabase
        .from("stakeholder_accounts")
        .select("id, tenant_id, nickname, custname, verification_status")
        .eq("id", stakeholder_account_id)
        .maybeSingle();
      account = data;
      if (!account) return json({ success: false, error: "Account not found" }, 404);

      const { data: membership } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .eq("tenant_id", account.tenant_id)
        .maybeSingle();
      if (!membership) return json({ error: "Forbidden" }, 403);
    }

    accountId = account.id;

    // ---- Exchange + fetch bank details ----------------------------------
    const exchange = await callPlaid<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token },
    );
    const accessToken = exchange.access_token;

    const auth = await callPlaid<any>("/auth/get", { access_token: accessToken });

    // Link may return several accounts; use the one the user selected.
    const numbers = auth?.numbers?.ach ?? [];
    const selected = account_id
      ? numbers.find((n: any) => n.account_id === account_id) ?? numbers[0]
      : numbers[0];

    if (!selected?.routing || !selected?.account) {
      return json(
        {
          success: false,
          error:
            "Plaid did not return account and routing numbers for the selected account. Choose a checking or savings account.",
        },
        400,
      );
    }

    const meta = (auth?.accounts ?? []).find((a: any) => a.account_id === selected.account_id);
    const institutionName = auth?.item?.institution_name ?? meta?.name ?? null;

    let holderName: string | null = null;
    try {
      const identity = await callPlaid<any>("/identity/get", { access_token: accessToken });
      const idAcct = (identity?.accounts ?? []).find(
        (a: any) => a.account_id === selected.account_id,
      );
      holderName = idAcct?.owners?.[0]?.names?.[0] ?? null;
    } catch (e) {
      // /identity is a separately-billed product; not fatal if unavailable.
      console.warn("[plaid-exchange] identity unavailable", (e as Error).message);
    }

    const last4 = String(selected.account).slice(-4);
    const nowIso = new Date().toISOString();

    const update: Record<string, unknown> = {
      chk_aba: String(selected.routing).replace(/\D/g, "").slice(0, 9),
      chk_acct: String(selected.account).replace(/\D/g, "").slice(-17),
      acct_type: acctTypeFromPlaid(meta?.subtype),
      verification_status: "verified",
      verification_source: "plaid",
      verified_at: nowIso,
      verification_completed_at: nowIso,
      verification_failure_reason: null,
      plaid_item_id: exchange.item_id,
      plaid_account_id: selected.account_id,
      plaid_access_token: accessToken,
      plaid_institution_name: institutionName,
      plaid_account_mask: last4,
      plaid_linked_at: nowIso,
    };

    if (holderName) update.custname = holderName.slice(0, 100);

    if (
      institutionName &&
      (!account.nickname ||
        account.nickname === "Bank Account (pending verification)" ||
        account.nickname === "Operating")
    ) {
      update.nickname = `${institutionName} ••${last4}`;
    }

    const { error: updErr } = await supabase
      .from("stakeholder_accounts")
      .update(update)
      .eq("id", account.id);
    if (updErr) throw new Error(updErr.message);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id: account.id,
      tenant_id: account.tenant_id,
      event_type: "plaid_verified",
      details: {
        item_id: exchange.item_id,
        account_id: selected.account_id,
        institution: institutionName,
        mask: last4,
      },
    });

    return json({
      success: true,
      verified: true,
      institution: institutionName,
      mask: last4,
      account_holder: update.custname ?? account.custname,
    });
  } catch (err: any) {
    console.error("[plaid-exchange]", err);
    if (accountId) {
      await supabase
        .from("stakeholder_accounts")
        .update({
          verification_status: "failed",
          verification_failure_reason: err.message?.slice(0, 300) ?? "Plaid link failed",
        })
        .eq("id", accountId);
    }
    return json({ success: false, error: err.message }, 400);
  }
});
