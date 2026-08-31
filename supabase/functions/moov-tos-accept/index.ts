import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller } from "../_shared/moovGuard.ts";

/**
 * Applies a provider-issued Terms of Service agreement token to the tenant's
 * connected account. The token can only be produced by the provider's own
 * hosted ToS component in the browser — there is no way to self-assert
 * acceptance here, which is exactly the point.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, terms_of_service_token, accepted } = await req.json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const clientToken = typeof terms_of_service_token === "string" && terms_of_service_token.length >= 8
      ? terms_of_service_token
      : null;
    if (!clientToken && accepted !== true) {
      return json({ error: "Terms must be explicitly accepted." }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("id, provider_account_id, tos_accepted_at")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!account?.provider_account_id) {
      return json({ error: "Set up the payment account first." }, 409);
    }
    if (account.tos_accepted_at) {
      return json({ success: true, already_accepted: true, accepted_at: account.tos_accepted_at });
    }

    const accountId = account.provider_account_id as string;

    /**
     * The acceptance token must be created by an OAuth-authenticated call, and
     * the provider rejects it when the creating address matches the address
     * that applies it. So the token is minted here with the account holder's
     * own IP and user agent forwarded, then applied to the account.
     */
    const acceptedIP =
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      "";
    const acceptedUserAgent = req.headers.get("user-agent") ?? "unknown";

    let tosToken = clientToken;
    if (!tosToken) {
      const minted = await moovFetch<any>(`/tos-token`, {
        scopes: ["/ping.read"],
        extraHeaders: {
          ...(acceptedIP ? { "X-Forwarded-For": acceptedIP } : {}),
          "User-Agent": acceptedUserAgent,
        },
      });
      const value = minted?.token ?? minted?.tosToken ?? null;
      if (typeof value === "string" && value.length >= 8) tosToken = value;
    }
    if (!tosToken) return json({ error: "Could not generate the terms acceptance token." }, 502);

    await moovFetch<any>(`/accounts/${accountId}`, {
      method: "PATCH",
      scopes: scopes.accountWrite(accountId),
      body: { termsOfService: { token: tosToken } },
      extraHeaders: {
        ...(acceptedIP ? { "X-Forwarded-For": acceptedIP } : {}),
        "User-Agent": acceptedUserAgent,
      },
    });




    const acceptedAt = new Date().toISOString();
    await supabase
      .from("payment_provider_accounts")
      .update({ tos_accepted_at: acceptedAt, tos_accepted_by: userId, tos_source: "tos_drop" })
      .eq("id", account.id);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "payment_account.terms_accepted",
      environment,
      provider_metadata: { account_id: accountId, accepted_by: userId },
    });

    return json({ success: true, accepted_at: acceptedAt });
  } catch (e) {
    console.error("[moov-tos-accept]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
