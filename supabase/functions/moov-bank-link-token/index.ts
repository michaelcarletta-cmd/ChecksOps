import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovToken, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

// Mints a short-lived browser token so the tenant can link its OWN business
// bank account through the provider's hosted component (Moov.js Drop).
//
// Raw routing and account numbers go straight from the browser to the provider.
// ChecksOps servers never see or store them — only safe metadata comes back
// via moov-sync (bank name, account type, last four, statuses).

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!account?.provider_account_id) {
      return json({ error: "Set up the payment account first." }, 409);
    }

    const accountId = account.provider_account_id as string;
    const token = await moovToken(scopes.dropBankLink(accountId));

    return json({
      success: true,
      account_id: accountId,
      token,
      // The browser needs to know which host to point Moov.js at.
      environment,
      public_key: Deno.env.get("MOOV_PUBLIC_KEY") ?? null,
    });
  } catch (e) {
    console.error("[moov-bank-link-token]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
