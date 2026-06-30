// Calls CheckAlt FinCapture read-only diagnostics:
//   action="user"    -> POST /fincapture/useraccount/getUserAccountInformation
//   action="account" -> POST /fincapture/useraccount/getDepositAccountInformation
//
// Both endpoints require an authenticated JWT + merchant header (handled by checkAltFetch)
// and a body containing { fiKey, userId } (and for account, accountNumber).
//
// Used by the "Verify user" / "Verify account" buttons in CheckAlt Integration Settings
// to confirm a tenant's registration is live on the vendor side.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  checkAltFetch,
  loadConfig,
} from "../_shared/checkalt.ts";

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  action: z.enum(["user", "account"]),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
    const userId = user?.id;
    if (userErr || !userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { tenant_id, action } = parsed.data;

    const { data: isTenantAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId, _tenant_id: tenant_id,
    });
    const { data: isPlatformAdmin } = await supabase.rpc("has_role", {
      _user_id: userId, _role: "admin",
    });
    if (!isTenantAdmin && !isPlatformAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cfg = await loadConfig(supabase);
    if (!cfg.fi_key) {
      return new Response(JSON.stringify({ error: "checkalt_config.fi_key not set" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: acct, error: acctErr } = await supabase
      .from("checkalt_tenant_accounts")
      .select("sso_user_id, deposit_account_number")
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (acctErr) throw acctErr;
    if (!acct?.sso_user_id) {
      return new Response(JSON.stringify({
        error: "No registered CheckAlt account for this tenant. Register first.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const path =
      action === "user"
        ? "/fincapture/useraccount/getUserAccountInformation"
        : "/fincapture/useraccount/getDepositAccountInformation";

    const payload: Record<string, unknown> = {
      fiKey: cfg.fi_key,
      userId: acct.sso_user_id,
    };
    if (action === "account") {
      if (!acct.deposit_account_number) {
        return new Response(JSON.stringify({
          error: "No deposit_account_number on registered account",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      payload.accountNumber = acct.deposit_account_number;
    }

    const resp = await checkAltFetch(supabase, path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const respText = await resp.text();
    let respJson: unknown;
    try { respJson = JSON.parse(respText); } catch { respJson = { raw: respText }; }

    if (!resp.ok) {
      const detailMsg =
        (respJson && typeof respJson === "object" && (respJson as any).message) ||
        (respJson && typeof respJson === "object" && (respJson as any).error) ||
        (typeof respText === "string" && respText.slice(0, 300)) ||
        `HTTP ${resp.status}`;
      console.error(`[checkalt-verify-account] ${action} failed [${resp.status}]:`, respText);
      // Return 200 with success:false so the browser surfaces the CheckAlt
      // error body (supabase.functions.invoke drops the body on non-2xx).
      return new Response(JSON.stringify({
        success: false,
        action,
        status: resp.status,
        details: respJson,
        error: `CheckAlt ${action} verification failed [${resp.status}]: ${detailMsg}`,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      action,
      data: respJson,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-verify-account]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
