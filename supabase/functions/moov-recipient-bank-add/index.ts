import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, moovConfigured, moovEnvironment, safeLastFour, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";

/**
 * PUBLIC, token-authenticated bank collection for the branded recipient page
 * (/pay-setup/:token).
 *
 * Moov.js exposes no hosted bank-account Drop, so the details are posted here
 * and forwarded straight to the provider. Only safe metadata (bank name,
 * last four) is persisted; full routing/account numbers are never stored or
 * logged. Ownership is proven afterwards with micro-deposits.
 */

const DIGITS = /^\d+$/;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }
    if (!moovConfigured()) return json({ error: "Payment provider is not configured." }, 503);

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    const holderName = String(body?.holder_name ?? "").trim();
    const holderType = body?.holder_type === "business" ? "business" : "individual";
    const bankAccountType = body?.bank_account_type === "savings" ? "savings" : "checking";
    const routingNumber = String(body?.routing_number ?? "").replace(/\D/g, "");
    const accountNumber = String(body?.account_number ?? "").replace(/\D/g, "");

    if (!token) return json({ error: "token is required" }, 400);
    if (holderName.length < 2 || holderName.length > 128) {
      return json({ error: "Enter the account holder name as it appears at the bank." }, 400);
    }
    if (!DIGITS.test(routingNumber) || routingNumber.length !== 9) {
      return json({ error: "Routing number must be exactly 9 digits." }, 400);
    }
    if (!DIGITS.test(accountNumber) || accountNumber.length < 4 || accountNumber.length > 17) {
      return json({ error: "Account number must be between 4 and 17 digits." }, 400);
    }

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

    let created: any;
    try {
      created = await moovFetch<any>(`/accounts/${accountId}/bank-accounts`, {
        method: "POST",
        scopes: scopes.bankAccountsWrite(accountId),
        body: {
          account: { holderName, holderType, accountNumber, routingNumber, bankAccountType },
        },
      });
    } catch (e) {
      console.error("[moov-recipient-bank-add] attach failed", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }

    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;
    if (!bankAccountId) return json({ error: "The provider did not return a bank account id." }, 502);

    const bankName = created?.bankName ?? null;
    const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
    const status = String(created?.status ?? "new").toLowerCase();

    await supabase
      .from("external_payment_recipients")
      .update({
        provider_bank_name: bankName,
        provider_last_four: lastFour,
        bank_linked_at: new Date().toISOString(),
        onboarding_status: status === "verified" ? "ready" : "awaiting_bank",
        token_used_at: new Date().toISOString(),
      })
      .eq("id", recipient.id);

    if (recipient.stakeholder_account_id) {
      await supabase
        .from("stakeholder_accounts")
        .update({ verification_status: status === "verified" ? "verified" : "pending" })
        .eq("id", recipient.stakeholder_account_id);
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.bank_account.connected",
      new_status: status,
      environment,
      provider_metadata: { bankName, lastFour, recipient_id: recipient.id, source: "recipient_link" },
    }));

    return json({ success: true, bank_name: bankName, last_four: lastFour, status });
  } catch (e) {
    console.error("[moov-recipient-bank-add]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
