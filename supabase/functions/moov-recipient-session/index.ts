import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovConfigured, moovEnvironment } from "../_shared/moovClient.ts";
import { corsHeaders, json } from "../_shared/moovGuard.ts";

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
      // Lovable's authenticated preview is served from this separate domain.
      // The provider binds browser OAuth tokens to the exact requesting origin,
      // so falling back to checksops.com makes the browser-side ToS PATCH fail
      // before our verification function is ever reached.
      || host.endsWith(".lovableproject.com");
    return approved ? `${url.protocol}//${url.host}` : fallback;
  } catch {
    return fallback;
  }
}

// PUBLIC endpoint for the branded recipient-payment page.
//
// The recipient has no ChecksOps login — they authenticate with the secure,
// expiring token from their link and nothing else. This returns a short-lived
// provider token scoped ONLY to that recipient's own account, so the hosted
// component can send their bank details straight to the provider.
//
// Raw routing/account numbers never touch this function or any ChecksOps
// server: the browser talks to the provider directly.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }
    if (!moovConfigured()) return json({ error: "Payment provider is not configured." }, 503);

    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ error: "token is required" }, 400);

    const environment = moovEnvironment();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status, environment, bank_linked_at, provider_bank_name, provider_last_four")
      .eq("secure_token", token)
      .maybeSingle();

    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.environment !== environment) {
      return json({ error: "This link is not valid for this environment." }, 400);
    }
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    if (!recipient.provider_account_id) {
      return json({ error: "This payment setup is not ready yet. Try again shortly." }, 409);
    }

    // Branding for the recipient page — safe, public tenant fields only.
    const { data: tenant } = await supabase
      .from("tenants")
      .select("name, logo_url, primary_color, secondary_color")
      .eq("id", recipient.tenant_id)
      .maybeSingle();

    const accountId = recipient.provider_account_id as string;

    return json({
      success: true,
      recipient: {
        id: recipient.id,
        name: recipient.display_name,
        status: recipient.onboarding_status,
        bank_linked: Boolean((recipient as any).bank_linked_at),
        bank_name: (recipient as any).provider_bank_name ?? null,
        last_four: (recipient as any).provider_last_four ?? null,
      },
      payer: {
        name: (tenant as any)?.name ?? "ChecksOps",
        logo_url: (tenant as any)?.logo_url ?? null,
        primary_color: (tenant as any)?.primary_color ?? null,
        secondary_color: (tenant as any)?.secondary_color ?? null,
      },
      account_id: accountId,
      environment,
    });
  } catch (e) {
    console.error("[moov-recipient-session]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
