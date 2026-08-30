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

    // Identity details the provider requires before it will pay this recipient.
    const firstName = String(body?.first_name ?? "").trim();
    const lastName = String(body?.last_name ?? "").trim();
    const dob = String(body?.dob ?? "").trim(); // YYYY-MM-DD (individuals)
    const addressLine1 = String(body?.address_line1 ?? "").trim();
    const city = String(body?.city ?? "").trim();
    const state = String(body?.state ?? "").trim().toUpperCase();
    const postalCode = String(body?.postal_code ?? "").trim();
    const ssn = String(body?.ssn ?? "").replace(/\D/g, "");
    const ein = String(body?.ein ?? "").replace(/\D/g, "");
    const tosToken = typeof body?.tos_token === "string" && body.tos_token.length >= 8
      ? String(body.tos_token)
      : null;

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

    // Identity validation — forwarded to the provider, never stored.
    if (!addressLine1 || !city || !/^[A-Z]{2}$/.test(state) || postalCode.length < 5) {
      return json({ error: "Enter your full legal address (street, city, state, ZIP)." }, 400);
    }
    if (holderType === "individual") {
      if (!firstName || !lastName) {
        return json({ error: "Enter your legal first and last name." }, 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        return json({ error: "Enter your date of birth." }, 400);
      }
      if (ssn.length !== 9) {
        return json({ error: "Enter your full 9-digit SSN." }, 400);
      }
    } else if (ein.length !== 9) {
      return json({ error: "Enter the business 9-digit EIN." }, 400);
    }
    if (!tosToken) {
      return json({ error: "Please review and accept the payment provider's Terms of Service." }, 400);
    }

    const environment = moovEnvironment();
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

    if ((recipient as any).stakeholder_account_id) {
      await supabase
        .from("stakeholder_accounts")
        .update({ verification_status: status === "verified" ? "verified" : "pending" })
        .eq("id", (recipient as any).stakeholder_account_id);
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
