// Registers a tenant's depositor "user account" with FinCapture via
// POST /fincapture/useraccount/register. The userId submitted here becomes
// the ssoKey used by checkalt-submit-deposit / checkalt-approve-deposit /
// checkalt-poll-status for this tenant going forward.
//
// Sample payload (from CheckAlt's own Postman collection):
//   {
//     fiKey, userId, firstName, lastName, emailAddress,
//     isSSORequest: true,
//     accountDataList: [{ accountNumber }]
//   }
//
// Gated to tenant admins (for their own tenant) or platform admins (any tenant).

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  checkAltFetch,
  getCheckAltFiKey,
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
    const { data: claims } = await supabase.auth.getClaims(token);
    const userId = claims?.claims?.sub;
    if (!userId) {
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

    const fiKey = getCheckAltFiKey();
    const payload = {
      fiKey,
      userId: sso_user_id,
      firstName: first_name,
      lastName: last_name,
      emailAddress: email,
      isSSORequest: true,
      accountDataList: [{ accountNumber: deposit_account_number }],
    };

    const resp = await checkAltFetch(supabase, "/fincapture/useraccount/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const respJson = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: "CheckAlt registration failed",
        status: resp.status,
        details: respJson,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

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
        last_register_payload: respJson,
      }, { onConflict: "tenant_id" });
    if (upsertErr) throw upsertErr;

    return new Response(JSON.stringify({ success: true, sso_user_id }), {
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
