import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, bindMoovEnvironment, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";

/**
 * PUBLIC, token-authenticated Terms of Service acceptance for recipients that
 * were onboarded BEFORE the provider required terms (or whose bank is already
 * on file). They open their /pay-setup/:token link and accept terms without
 * re-entering bank details.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    if (!token) return json({ error: "token is required" }, 400);


    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment")
      .eq("secure_token", token)
      .maybeSingle();

    if (!recipient) return json({ error: "This link is not valid." }, 404);
    // Honour the ledger the recipient was created on (sandbox for test tenants).
    bindMoovEnvironment(String((recipient as any).environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) {
      return json({ error: "Payment provider is not configured." }, 503);
    }
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    const accountId = recipient.provider_account_id as string | null;
    if (!accountId) return json({ error: "This payment setup is not ready yet." }, 409);
    // Legacy links may still call this endpoint. A receive-only stakeholder
    // only needs transfers, which does not require a platform agreement.
    try {
      await moovFetch<any>(`/accounts/${accountId}/capabilities`, {
        method: "POST",
        scopes: scopes.capabilitiesWrite(accountId),
        body: { capabilities: ["transfers"] },
      });
    } catch (e) {
      console.error("[moov-recipient-tos-accept] capabilities", (e as Error).message);
      return json(
        { error: "The payment provider could not finish enabling this recipient. Please try again." },
        502,
      );
    }



    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.transfers.enabled",
      environment,
      provider_metadata: { recipient_id: recipient.id, source: "recipient_link" },
    }));

    return json({ success: true });
  } catch (e) {
    console.error("[moov-recipient-tos-accept]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
