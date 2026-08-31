import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
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
    if (!moovConfigured()) return json({ error: "Payment provider is not configured." }, 503);

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    const tosToken = typeof body?.tos_token === "string" && body.tos_token.length >= 8
      ? String(body.tos_token)
      : null;

    if (!token) return json({ error: "token is required" }, 400);

    const environment = moovEnvironment();
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
    if (recipient.environment !== environment) {
      return json({ error: "This link is not valid for this environment." }, 400);
    }
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    const accountId = recipient.provider_account_id as string | null;
    if (!accountId) return json({ error: "This payment setup is not ready yet." }, 409);
    let patchError: string | null = null;
    if (tosToken) {
      try {
        await moovFetch<any>(`/accounts/${accountId}`, {
          method: "PATCH",
          scopes: scopes.accountWrite(accountId),
          body: { termsOfService: { token: tosToken } },
        });
      } catch (e) {
        patchError = (e as Error).message ?? "patch failed";
        console.error("[moov-recipient-tos-accept] patch failed", patchError);
      }
    }

    // Verify the agreement is genuinely on file before reporting success — a
    // 403 can mean "already accepted" OR "token invalid", and only the account
    // record can tell the two apart.
    let termsOnFile = false;
    try {
      const acct = await moovFetch<any>(`/accounts/${accountId}`, {
        method: "GET",
        scopes: scopes.accountRead(accountId),
      });
      termsOnFile = Boolean(
        acct?.termsOfServiceAcceptance?.acceptedDate ??
          acct?.termsOfService?.acceptedDate ??
          acct?.termsOfServiceAcceptance?.acceptedOn,
      );
    } catch (e) {
      console.error("[moov-recipient-tos-accept] verify", (e as Error).message);
    }

    if (!termsOnFile) {
      console.error("[moov-recipient-tos-accept] acceptance not present", patchError ?? "client acceptance not recorded");
      return json(
        { error: "The payment provider could not record your acceptance. Please try again." },
        502,
      );
    }

    // Terms are a prerequisite for the payout capability — request it now so a
    // previously blocked recipient becomes payable. Recipients only ever
    // receive pushed funds, so "send-funds" is the only valid capability here.
    try {
      await moovFetch<any>(`/accounts/${accountId}/capabilities`, {
        method: "POST",
        scopes: scopes.capabilitiesWrite(accountId),
        body: { capabilities: ["send-funds"] },
      });
    } catch (e) {
      console.error("[moov-recipient-tos-accept] capabilities", (e as Error).message);
      return json(
        { error: "Your agreement was recorded, but the payment provider could not finish enabling payments. Please try again." },
        502,
      );
    }



    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.terms.accepted",
      environment,
      provider_metadata: { recipient_id: recipient.id, source: "recipient_link" },
    }));

    return json({ success: true });
  } catch (e) {
    console.error("[moov-recipient-tos-accept]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
