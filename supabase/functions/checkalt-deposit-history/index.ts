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

    // Default to last 30 days
    const today = new Date();
    const defaultEnd = today.toISOString().slice(0, 10);
    const defaultStart = new Date(today.getTime() - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const payload = {
      fiKey: cfg.fi_key,
      ssoKey: tenant.sso_user_id,
      accountNumber: body.account_number ?? tenant.deposit_account_number,
      startDate: body.start_date ?? defaultStart,
      endDate: body.end_date ?? defaultEnd,
    };

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
      return new Response(
        JSON.stringify({ error: `CheckAlt history failed [${resp.status}]`, detail: json }),
        {
          status: resp.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
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
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
