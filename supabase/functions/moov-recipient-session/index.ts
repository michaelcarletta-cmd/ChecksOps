import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bindMoovEnvironment, moovConfigured, moovEnvironment, moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json } from "../_shared/moovGuard.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") return json({ error: "This payment provider is not enabled." }, 403);
    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ error: "token is required" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: recipient } = await supabase.from("external_payment_recipients")
      .select("id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status, environment, bank_linked_at, provider_bank_name, provider_last_four")
      .eq("secure_token", token).maybeSingle();
    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    if (!recipient.provider_account_id) return json({ error: "This payment setup is not ready yet. Try again shortly." }, 409);

    bindMoovEnvironment(String(recipient.environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) return json({ error: "Payment provider is not configured." }, 503);

    const { data: tenant } = await supabase.from("tenants").select("name, logo_url, primary_color, secondary_color").eq("id", recipient.tenant_id).maybeSingle();
    const accountId = String(recipient.provider_account_id);
    const account = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) }).catch(() => null);
    const verificationStatus = String(account?.profile?.individual?.verification?.status ?? account?.verification?.status ?? "unverified").toLowerCase();
    const tosAccepted = Boolean(account?.termsOfService?.acceptedDate ?? account?.termsOfService?.acceptedOn);

    return json({
      success: true,
      recipient: {
        id: recipient.id, name: recipient.display_name, status: recipient.onboarding_status,
        bank_linked: Boolean(recipient.bank_linked_at), bank_name: recipient.provider_bank_name ?? null,
        last_four: recipient.provider_last_four ?? null,
      },
      onboarding: { terms_accepted: tosAccepted, verification_status: verificationStatus },
      payer: {
        name: tenant?.name ?? "ChecksOps", logo_url: tenant?.logo_url ?? null,
        primary_color: tenant?.primary_color ?? null, secondary_color: tenant?.secondary_color ?? null,
      },
      account_id: accountId,
      environment,
    });
  } catch (e) {
    console.error("[moov-recipient-session]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
