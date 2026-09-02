import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, bindMoovEnvironment, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";

/** Public, secure-link Terms acceptance for an external recipient/stakeholder. */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    if (!token || body?.accepted !== true) return json({ error: "Terms must be explicitly accepted." }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment")
      .eq("secure_token", token)
      .maybeSingle();

    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    if (!recipient.provider_account_id) return json({ error: "This payment setup is not ready yet." }, 409);

    bindMoovEnvironment(String(recipient.environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) return json({ error: "Payment provider is not configured." }, 503);

    const accountId = String(recipient.provider_account_id);
    const current = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    const alreadyAccepted = Boolean(current?.termsOfService?.acceptedDate ?? current?.termsOfService?.acceptedOn);

    if (!alreadyAccepted) {
      const userAgent = req.headers.get("user-agent") ?? "unknown";
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim()
        || req.headers.get("cf-connecting-ip")
        || req.headers.get("x-real-ip")
        || "";
      const extraHeaders = {
        ...(ip ? { "X-Forwarded-For": ip, "X-Real-IP": ip } : {}),
        "User-Agent": userAgent,
      };
      const minted = await moovFetch<any>("/tos-token", {
        scopes: ["/ping.read"],
        extraHeaders,
      });
      const tosToken = minted?.token ?? minted?.tosToken;
      if (!tosToken) return json({ error: "Could not generate the terms acceptance token." }, 502);

      await moovFetch<any>(`/accounts/${accountId}`, {
        method: "PATCH",
        scopes: scopes.accountWrite(accountId),
        body: { termsOfService: { token: tosToken } },
        extraHeaders,
      });
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.terms_accepted",
      environment,
      provider_metadata: { recipient_id: recipient.id, account_id: accountId, source: "recipient_link" },
    }));

    return json({ success: true, already_accepted: alreadyAccepted });
  } catch (e) {
    console.error("[moov-recipient-tos-accept]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
