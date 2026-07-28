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

    // Moov requires at least one fee plan code on an onboarding invite.
    // Prefer an explicit configuration, otherwise discover the platform's plans.
    const envPlatformId = Deno.env.get("MOOV_PLATFORM_ACCOUNT_ID") ?? null;
    let platformAccountId = envPlatformId ?? accountId;
    let feePlanCodes = (Deno.env.get("MOOV_FEE_PLAN_CODES") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    if (feePlanCodes.length === 0) {
      // Candidate partner accounts to search for fee plans: the configured
      // platform account, then any account the platform credentials can see.
      const candidates: string[] = [];
      if (envPlatformId) candidates.push(envPlatformId);

      if (candidates.length === 0) {
        try {
          const accounts = await moovFetch<any>("/accounts", {
            method: "GET",
            scopes: scopes.accountsWrite(),
          });
          const list = Array.isArray(accounts) ? accounts : accounts?.accounts ?? [];
          for (const a of list) {
            const id = a?.accountID ?? a?.accountId;
            if (typeof id === "string" && id && id !== accountId) candidates.push(id);
          }
        } catch (e) {
          console.error("[moov-onboarding-link] account list", (e as Error).message);
        }
      }
      candidates.push(accountId);

      for (const candidate of candidates) {
        try {
          const plans = await moovFetch<any>(`/accounts/${candidate}/fee-plans`, {
            method: "GET",
            scopes: scopes.accountWrite(candidate),
          });
          const list = Array.isArray(plans) ? plans : plans?.feePlans ?? [];
          const codes = list
            .map((p: any) => p?.planCode ?? p?.code)
            .filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
          if (codes.length > 0) {
            feePlanCodes = codes.slice(0, 1);
            platformAccountId = candidate;
            break;
          }
        } catch (e) {
          console.error("[moov-onboarding-link] fee plan lookup", candidate, (e as Error).message);
        }
      }
    }

    if (feePlanCodes.length === 0) {
      return json(
        {
          error:
            "No fee plan is set up on your payment platform yet. Create a fee plan in the provider dashboard (sandbox environment), then send us the plan code so we can pin it.",
        },
        409,
      );
    }


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
        feePlanCodes,
        partnerAccountID: platformAccountId,
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
