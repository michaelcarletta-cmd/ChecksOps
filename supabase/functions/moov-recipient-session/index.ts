import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bindMoovEnvironment, moovConfigured, moovEnvironment, moovFetch, moovToken, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json } from "../_shared/moovGuard.ts";
import {
  identityRequirementsOutstanding,
  kycStatusFromMoov,
  liveAccountReadFailed,
  liveBankVerified,
  liveTosAccepted,
  recipientOnboardingCompleteFromMoov,
  tosRequirementOutstanding,
} from "../_shared/recipientTosPolicy.ts";

function approvedBrowserOrigin(req: Request): string {
  const fallback = "https://checksops.com";
  const raw = req.headers.get("origin");
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const approved = host === "checksops.com"
      || host === "www.checksops.com"
      || host === "claim-buddy-crm.lovable.app"
      || host.endsWith(".lovable.app")
      || host.endsWith(".lovableproject.com");
    return approved ? `${url.protocol}//${url.host}` : fallback;
  } catch {
    return fallback;
  }
}

const listOf = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  return [];
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }
    const { token, account_id: requestedAccountId } = await req.json().catch(() => ({}));
    if (!token || typeof token !== "string") return json({ error: "token is required" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: recipient } = await supabase.from("external_payment_recipients")
      .select("id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status, environment, bank_linked_at, provider_bank_name, provider_last_four")
      .eq("secure_token", token).maybeSingle();
    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    if (!recipient.provider_account_id) return json({ error: "This payment setup is not ready yet. Try again shortly." }, 409);

    bindMoovEnvironment(String(recipient.environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) return json({ error: "Payment provider is not configured." }, 503);

    const accountId = String(recipient.provider_account_id);
    if (requestedAccountId && String(requestedAccountId) !== accountId) {
      return json({ error: "tos_account_mismatch" }, 400);
    }

    const { data: tenant } = await supabase.from("tenants").select("name, logo_url, primary_color, secondary_color").eq("id", recipient.tenant_id).maybeSingle();
    const account = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) }).catch(() => null);
    if (liveAccountReadFailed(account)) {
      return json({ error: "moov_account_get_failed", message: "Could not load the payment-provider account." }, 502);
    }
    let capabilities: any[] = [];
    let capabilitiesReadOk = false;
    try {
      const caps = await moovFetch<any>(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId) });
      capabilities = listOf(caps);
      capabilitiesReadOk = true;
    } catch { /* unread capabilities cannot confirm ToS */ }
    let banks: any[] = [];
    try {
      const bankPayload = await moovFetch<any>(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId) });
      banks = listOf(bankPayload);
    } catch { /* live bank unread */ }

    const verificationStatus = kycStatusFromMoov(account ?? {});
    const tosAccepted = liveTosAccepted(account ?? {});
    const tosOutstanding = capabilitiesReadOk ? tosRequirementOutstanding(capabilities) : true;
    const identityOutstanding = capabilitiesReadOk ? identityRequirementsOutstanding(capabilities) : [];
    const bankVerified = liveBankVerified(banks);
    const complete = recipientOnboardingCompleteFromMoov({
      account,
      banks,
      capabilities,
      capabilitiesReadOk,
    });
    const dropToken = tosAccepted
      ? null
      : await moovToken(scopes.dropTos(accountId), approvedBrowserOrigin(req));

    return json({
      success: true,
      recipient: {
        id: recipient.id,
        name: recipient.display_name,
        status: complete ? "ready" : (tosAccepted || !tosOutstanding ? (verificationStatus === "verified" ? "awaiting_bank" : "kyc_pending") : "awaiting_kyc"),
        bank_linked: banks.length > 0,
        bank_name: recipient.provider_bank_name ?? null,
        last_four: recipient.provider_last_four ?? null,
      },
      onboarding: {
        terms_accepted: tosAccepted,
        tos_requirement_outstanding: tosOutstanding,
        verification_status: verificationStatus,
        identity_requirements_outstanding: identityOutstanding,
        identity_requirements_known: capabilitiesReadOk,
        bank_verified: bankVerified,
        bank_status: banks[0] ? String(banks[0]?.status ?? banks[0]?.verificationStatus ?? "new").toLowerCase() : null,
        complete,
        live: true,
      },
      payer: {
        name: tenant?.name ?? "ChecksOps",
        logo_url: tenant?.logo_url ?? null,
        primary_color: tenant?.primary_color ?? null,
        secondary_color: tenant?.secondary_color ?? null,
      },
      account_id: accountId,
      environment,
      token: dropToken,
      drop: "moov-terms-of-service",
      public_key: null,
    });
  } catch (e) {
    console.error("[moov-recipient-session]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
