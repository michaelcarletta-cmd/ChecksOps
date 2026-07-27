import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller } from "../_shared/moovGuard.ts";

// Generates the hosted onboarding (KYB/KYC) link for a tenant's own connected
// account, then returns the tenant to ChecksOps when they finish.
//
// The UI labels this "Set Up Payment Account" — the provider is never named.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, return_url } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!account?.provider_account_id) {
      return json({ error: "Set up the payment account first." }, 409);
    }

    const accountId = account.provider_account_id as string;
    const redirect = typeof return_url === "string" && return_url.startsWith("http")
      ? return_url
      : `${Deno.env.get("CHECKSOPS_APP_URL") ?? "https://checksops.com"}/payments?tab=settings`;

    // Moov hosted onboarding invite for this specific connected account.
    const invite = await moovFetch<any>("/onboarding-invites", {
      method: "POST",
      scopes: [...scopes.accountsWrite(), ...scopes.accountWrite(accountId)],
      body: {
        scopes: [
          "/accounts.write",
          `/accounts/${accountId}/profile.write`,
          `/accounts/${accountId}/representatives.write`,
          `/accounts/${accountId}/bank-accounts.write`,
          `/accounts/${accountId}/capabilities.write`,
        ],
        capabilities: ["transfers", "send-funds", "collect-funds", "wallet"],
        feePlanCodes: [],
        partnerAccountID: accountId,
        redirectURL: redirect,
      },
    });

    const url = invite?.link ?? invite?.url ?? null;
    if (!url) return json({ error: "Could not generate an onboarding link." }, 502);

    const expiresAt = invite?.expiresOn ?? invite?.expiresAt ?? null;

    await supabase
      .from("payment_provider_accounts")
      .update({ onboarding_url: url, onboarding_url_expires_at: expiresAt })
      .eq("id", account.id);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "payment_account.onboarding_link_generated",
      environment,
      provider_metadata: { account_id: accountId },
    });

    return json({ success: true, url, expires_at: expiresAt });
  } catch (e) {
    console.error("[moov-onboarding-link]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
