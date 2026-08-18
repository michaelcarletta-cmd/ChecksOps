import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovToken } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

/**
 * Mints a short-lived browser token for the provider's hosted Terms of Service
 * component. The component itself records the acceptance (IP, user agent,
 * timestamp) with the provider — ChecksOps never fakes or self-asserts it, and
 * we only store the resulting acceptance timestamp for display.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { environment } = caller;

    const token = await moovToken(["/terms-of-service.write"]);

    return json({
      success: true,
      token,
      environment,
      public_key: Deno.env.get("MOOV_PUBLIC_KEY") ?? null,
    });
  } catch (e) {
    console.error("[moov-tos-token]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
