import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovToken } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

/**
 * Mints a short-lived browser token for the provider's hosted Terms of Service
 * component (Moov.js `<moov-terms-of-service>` Drop).
 *
 * The Drop calls Moov's "generate a terms of service token" endpoint itself and
 * only needs a generic API access token. There is no `/terms-of-service.write`
 * scope in Moov's scope reference — the minimal non-account-restricted scope
 * (`/ping.read`) is what the Drop is authenticated with. The Drop records the
 * acceptance (IP, user agent, timestamp) with Moov; ChecksOps never self-asserts
 * it and only stores the resulting acceptance timestamp for display.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { environment, supabase } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = (account?.provider_account_id as string | null) ?? null;

    // The browser session needs profile write on the tenant account so the
    // acceptance token it mints is bound to that account.
    const sessionScopes = accountId
      ? [`/accounts/${accountId}/profile.write`, `/accounts/${accountId}/profile.read`, "/ping.read"]
      : ["/ping.read"];

    const token = await moovToken(sessionScopes);

    return json({
      success: true,
      token,
      environment,
      account_id: accountId,
      public_key: Deno.env.get("MOOV_PUBLIC_KEY") ?? null,
    });

  } catch (e) {
    console.error("[moov-tos-token]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
