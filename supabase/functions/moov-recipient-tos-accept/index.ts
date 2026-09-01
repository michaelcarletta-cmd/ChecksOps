import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, moovConfigured, moovEnvironment, moovHost, scopes } from "../_shared/moovClient.ts";
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
    const browserOauthToken = typeof body?.browser_oauth_token === "string" && body.browser_oauth_token.length >= 20
      ? String(body.browser_oauth_token)
      : null;
    const verifyOnly = body?.verify_only === true;

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
    if (!verifyOnly) {
      if (!tosToken || !browserOauthToken) {
        return json({ error: "Terms acceptance session is required. Refresh the page and try again." }, 400);
      }
      try {
        const response = await fetch(`${moovHost()}/accounts/${accountId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${browserOauthToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: req.headers.get("origin") ?? "https://checksops.com",
            "x-moov-version": Deno.env.get("MOOV_API_VERSION") ?? "v2024.01.00",
          },
          body: JSON.stringify({ termsOfService: { token: tosToken } }),
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      } catch (e) {
        patchError = (e as Error).message ?? "patch failed";
        console.error("[moov-recipient-tos-accept] patch failed", patchError);
      }
    }

    // The provider does NOT return terms-of-service fields on GET /accounts.
    // The only reliable signal is the payout capability's outstanding
    // requirements: while terms are missing, "account.tos-acceptance" (or a
    // similarly named terms requirement) stays in the requirement list.
    async function termsRequirementOutstanding(): Promise<boolean | null> {
      try {
        const caps = await moovFetch<any>(`/accounts/${accountId}/capabilities`, {
          method: "GET",
          scopes: scopes.capabilitiesRead(accountId),
        });
        const list = Array.isArray(caps) ? caps : caps?.capabilities ?? [];
        const raw = JSON.stringify(list ?? []);
        console.log(
          "[moov-recipient-tos-accept] capabilities",
          JSON.stringify({ accountID: accountId, capabilities: list }),
        );
        return /tos|terms/i.test(raw);
      } catch (e) {
        console.error("[moov-recipient-tos-accept] capability read", (e as Error).message);
        return null;
      }
    }

    // Capability requirements can lag briefly after the browser-side account
    // PATCH succeeds. Poll before reporting failure so a successful acceptance
    // is not rejected because of provider-side eventual consistency.
    let outstanding = await termsRequirementOutstanding();
    if (verifyOnly && outstanding === true) {
      for (const delayMs of [750, 1_500, 2_500]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        outstanding = await termsRequirementOutstanding();
        if (outstanding !== true) break;
      }
    }
    if (outstanding === true) {
      console.error(
        "[moov-recipient-tos-accept] terms requirement still outstanding",
        patchError ?? "client acceptance not recorded",
      );
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
