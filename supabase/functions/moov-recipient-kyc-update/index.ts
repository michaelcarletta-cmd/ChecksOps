import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bindMoovEnvironment, moovConfigured, moovEnvironment, moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, moovGloballyEnabled, sanitize } from "../_shared/moovGuard.ts";
import {
  buildIndividualKycPatch,
  identityRequirementsOutstanding,
  kycStatusFromMoov,
} from "../_shared/recipientTosPolicy.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!moovGloballyEnabled()) {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    if (!token) return json({ error: "token is required" }, 400);

    const patch = buildIndividualKycPatch(body);
    if (!patch.ok) {
      if (patch.missing.includes("name")) return json({ error: "First and last name are required." }, 400);
      if (patch.missing.includes("email")) return json({ error: "Enter a valid email address." }, 400);
      if (patch.missing.includes("phone")) return json({ error: "Phone number must be 10 digits." }, 400);
      if (patch.missing.includes("address")) return json({ error: "Enter a complete U.S. residential address." }, 400);
      if (patch.missing.includes("birthdate")) return json({ error: "Enter a valid date of birth." }, 400);
      if (patch.missing.includes("ssn")) return json({ error: "SSN must be 9 digits." }, 400);
      return json({ error: "kyc_fields_incomplete" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment, stakeholder_account_id")
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
    const account = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    if (account?.accountType && account.accountType !== "individual") {
      return json({ error: "This recipient requires business verification instead of individual KYC." }, 409);
    }

    await moovFetch<any>(`/accounts/${accountId}`, {
      method: "PATCH",
      scopes: scopes.accountWrite(accountId),
      body: patch.body,
    });

    const refreshed = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    const verification = kycStatusFromMoov(refreshed);
    let identityOutstanding: string[] = [];
    try {
      const caps = await moovFetch<any>(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId) });
      const list = Array.isArray(caps) ? caps : caps?.capabilities ?? [];
      identityOutstanding = identityRequirementsOutstanding(list);
    } catch { /* unread */ }

    await supabase
      .from("external_payment_recipients")
      .update({ onboarding_status: verification === "verified" ? "awaiting_bank" : "kyc_pending" })
      .eq("id", recipient.id);

    if (recipient.stakeholder_account_id) {
      await supabase
        .from("stakeholder_accounts")
        .update({ verification_status: verification === "verified" ? "verified" : "pending" })
        .eq("id", recipient.stakeholder_account_id);
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.kyc.submitted",
      new_status: verification,
      environment,
      provider_metadata: { recipient_id: recipient.id, account_id: accountId },
    }));

    return json({
      success: true,
      verification_status: verification,
      identity_requirements_outstanding: identityOutstanding,
      account_id: accountId,
      environment,
    });
  } catch (e) {
    console.error("[moov-recipient-kyc-update]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
