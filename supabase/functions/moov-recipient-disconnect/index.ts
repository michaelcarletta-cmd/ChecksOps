import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";

/**
 * Disconnects a stakeholder / recipient account at the payment provider.
 *
 * Provider accounts can never be deleted — they can only be disconnected from
 * the platform, which stops further verification (KYC/KYB) billing on them.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    if (!moovConfigured()) return json({ error: "Payment provider is not configured." }, 503);

    const body = await req.json().catch(() => ({}));
    const stakeholderAccountId = String(body?.stakeholder_account_id ?? "");
    if (!stakeholderAccountId) return json({ error: "stakeholder_account_id is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: account } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, provider_account_id")
      .eq("id", stakeholderAccountId)
      .maybeSingle();
    if (!account) return json({ error: "Account not found" }, 404);

    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", account.tenant_id)
      .maybeSingle();
    if (!membership) return json({ error: "Forbidden" }, 403);

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, provider_account_id")
      .eq("stakeholder_account_id", stakeholderAccountId)
      .maybeSingle();

    const providerAccountId = (account as any).provider_account_id
      ?? (recipient as any)?.provider_account_id
      ?? null;

    if (!providerAccountId) {
      return json({ success: true, disconnected: false, reason: "No provider account on file." });
    }

    let disconnected = false;
    try {
      await moovFetch<any>(`/accounts/${providerAccountId}`, {
        method: "DELETE",
        scopes: scopes.accountWrite(providerAccountId),
      });
      disconnected = true;
    } catch (e) {
      const message = (e as Error).message ?? "";
      if (/not found|404|disconnected/i.test(message)) {
        disconnected = true;
      } else {
        console.error("[moov-recipient-disconnect]", message);
        return json({ error: "The payment provider could not disconnect this account." }, 502);
      }
    }

    if (recipient?.id) {
      await supabase
        .from("external_payment_recipients")
        .update({ onboarding_status: "disconnected", secure_token: null })
        .eq("id", recipient.id);
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: account.tenant_id,
      event_type: "recipient.account.disconnected",
      environment: moovEnvironment(),
      provider_metadata: { stakeholder_account_id: stakeholderAccountId, provider_account_id: providerAccountId },
    }));

    return json({ success: true, disconnected });
  } catch (e) {
    console.error("[moov-recipient-disconnect]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
