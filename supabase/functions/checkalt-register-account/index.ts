// Registers a tenant's depositor "user account" with FinCapture via
// POST /fincapture/useraccount/register, then immediately calls
// getUserAccountInformation to retrieve the ssoKey assigned by CheckAlt.
//
// The ssoKey (NOT the userId) is what deposit/approve/poll endpoints require.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  checkAltFetch,
  loadConfig,
  getUserAccountInfo,
  extractSsoKey,
} from "../_shared/checkalt.ts";

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  sso_user_id: z.string().min(1).max(64),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email(),
  deposit_account_number: z.string().min(1).max(34),
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
    const { tenant_id, sso_user_id, first_name, last_name, email, deposit_account_number } = parsed.data;

    const { data: isTenantAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: tenant_id,
    });
    const { data: isPlatformAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isTenantAdmin && !isPlatformAdmin) {
      return new Response(JSON.stringify({ error: "Only tenant or platform admins can register a CheckAlt account" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cfg = await loadConfig(supabase);
    if (!cfg.fi_key) {
      return new Response(JSON.stringify({ error: "checkalt_config.fi_key not set" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 1: Register user with CheckAlt ──
    // Payload shape per CheckAlt's official sample:
    //   fiKey, ssorequest (lowercase), userID (capital ID), firstName, lastName,
    //   emailAddress, SSORequest (also included for compatibility), accountDataList
    // Include every documented key-casing variant CheckAlt has shown in samples:
    //   ssorequest (lowercase) + SSORequest + isSSORequest
    //   userID (capital ID) + userId
    // CheckAlt ignores unknown keys, so sending all variants is safe.
    const payload = {
      fiKey: cfg.fi_key,
      ssorequest: true,
      SSORequest: true,
      isSSORequest: true,
      userID: sso_user_id,
      userId: sso_user_id,
      firstName: first_name,
      lastName: last_name,
      emailAddress: email,
      accountDataList: [{ accountNumber: deposit_account_number }],
    };

    const resp = await checkAltFetch(supabase, "/fincapture/useraccount/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const respText = await resp.text();
    let respJson: unknown;
    try { respJson = JSON.parse(respText); } catch { respJson = { raw: respText }; }

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: "CheckAlt registration failed",
        status: resp.status,
        details: respJson,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    console.log("[checkalt-register-account] registration OK:", respText.slice(0, 500));

    // ── Step 2: Fetch ssoKey from getUserAccountInformation ──
    let ssoKey: string | null = null;
    let userAccountPayload: any = null;
    try {
      const info = await getUserAccountInfo(supabase, sso_user_id);
      userAccountPayload = info.json;
      console.log("[checkalt-register-account] getUserAccountInfo:", JSON.stringify(info.json).slice(0, 500));

      if (info.ok) {
        ssoKey = extractSsoKey(info.json, deposit_account_number);
      }
    } catch (e) {
      // Non-fatal — log but continue. The registration itself succeeded.
      console.error("[checkalt-register-account] getUserAccountInfo failed:", e);
    }

    // ── Step 3: Store in DB ──
    const { error: upsertErr } = await supabase
      .from("checkalt_tenant_accounts")
      .upsert({
        tenant_id,
        sso_user_id,
        deposit_account_number,
        first_name,
        last_name,
        email,
        enabled: true,
        registered_at: new Date().toISOString(),
        last_register_payload: {
          register_response: respJson,
          user_account_info: userAccountPayload,
          sso_key: ssoKey,
        },
      }, { onConflict: "tenant_id" });
    if (upsertErr) throw upsertErr;

    const warning = ssoKey
      ? undefined
      : "Registration succeeded but CheckAlt did not return an ssoKey in getUserAccountInformation. " +
        "The userId will be used as ssoKey for deposits. If deposits fail, contact CheckAlt support.";

    return new Response(JSON.stringify({
      success: true,
      sso_user_id,
      sso_key: ssoKey,
      warning,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-register-account]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
