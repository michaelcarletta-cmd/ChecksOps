// Fetches deposit history from CheckAlt FinCapture.
// POST /fincapture/deposit/history with { fiKey, ssoKey, startDate, endDate }
// per Clearingworks FinCapture API spec.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import {
  getServiceClient,
  loadConfig,
  loadTenantAccount,
  checkAltFetch,
} from "../_shared/checkalt.ts";

interface Body {
  tenant_id?: string;
  start_date?: string; // YYYY-MM-DD
  end_date?: string;
  account_number?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = getServiceClient();

    // Authenticate caller
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: Body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    const cfg = await loadConfig(supabase);
    if (!cfg.fi_key) {
      return new Response(JSON.stringify({ error: "checkalt_config.fi_key not set" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve tenant for ssoKey
    let tenantId = body.tenant_id;
    if (!tenantId) {
      const { data: tu } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", userData.user.id)
        .limit(1)
        .maybeSingle();
      tenantId = tu?.tenant_id ?? undefined;
    }
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "No tenant resolved for user" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tenant = await loadTenantAccount(supabase, tenantId);

    // Prefer the cached CheckAlt-issued ssoKey (from registration) over the raw sso_user_id.
    // Submit/approve flows do the same; history must match or CheckAlt returns "no records".
    const { data: acctRow } = await supabase
      .from("checkalt_tenant_accounts")
      .select("last_register_payload")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const cached = (acctRow?.last_register_payload ?? {}) as { sso_key?: string };
    const ssoKey = cached.sso_key || tenant.sso_user_id;

    // Default to last 30 days
    const today = new Date();
    const defaultEnd = today.toISOString().slice(0, 10);
    const defaultStart = new Date(today.getTime() - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const payload = {
      fiKey: cfg.fi_key,
      userId: tenant.sso_user_id,
      ssoKey,
      accountNumber: body.account_number ?? tenant.deposit_account_number,
      startDate: body.start_date ?? defaultStart,
      endDate: body.end_date ?? defaultEnd,
    };

    console.log("[checkalt-deposit-history] request", {
      tenantId,
      ssoKey,
      accountNumber: payload.accountNumber,
      startDate: payload.startDate,
      endDate: payload.endDate,
    });

    const resp = await checkAltFetch(supabase, "/fincapture/deposit/history", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const raw = await resp.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      json = { raw };
    }

    if (!resp.ok) {
      console.error("[checkalt-deposit-history] upstream error", resp.status, json);
      return new Response(
        JSON.stringify({
          error: `CheckAlt history failed [${resp.status}]: ${
            typeof json === "object" ? JSON.stringify(json) : String(json)
          }`,
          status: resp.status,
          detail: json,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Normalize: spec returns depositHistoryList (array of FinCaptureAPIDepositHistoryItem)
    const items: any[] =
      json?.depositHistoryList ??
      json?.depositList ??
      json?.history ??
      (Array.isArray(json) ? json : []);

    return new Response(
      JSON.stringify({
        ok: true,
        range: { start_date: payload.startDate, end_date: payload.endDate },
        count: items.length,
        items,
        raw: json,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[checkalt-deposit-history] exception", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
