import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/moovGuard.ts";

/**
 * Retired (owner decision 2026-10-17).
 *
 * This function took the amount and line items from the browser and pulled
 * them into the first facilitator wallet. Tenant fees are now collected by the
 * ChecksOps platform owner from Tenant Management through tenant-billing-admin:
 * a server-computed preview, then a pull carrying the preview hash. The server
 * computes the amount from the Billing tab rates and pays the ChecksOps
 * platform account. Nothing is read, written or sent here.
 */
serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return json(
    {
      error: "use_tenant_billing_pull",
      message:
        "moov-tenant-fee-charge is retired. Collect tenant fees from Tenant Management (tenant-billing-admin preview, then pull).",
    },
    410,
  );
});
