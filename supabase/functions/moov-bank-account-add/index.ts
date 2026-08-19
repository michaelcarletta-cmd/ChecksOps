import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, safeLastFour, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";

/**
 * Attaches the organization's own settlement bank account to its provider
 * account by routing / account number.
 *
 * Moov.js has no hosted bank-account Drop (the SDK only registers card,
 * onboarding, terms-of-service, file-upload and payment-method components), so
 * the settlement bank is collected by us and forwarded straight to the
 * provider. We persist only safe metadata: bank name, holder name, account
 * type and the last four digits. Full account and routing numbers are never
 * written to the database or to logs.
 *
 * Ownership is proven afterwards with the existing instant micro-deposit flow.
 */

const DIGITS = /^\d+$/;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenantId = body?.tenant_id;
    const holderName = String(body?.holder_name ?? "").trim();
    const holderType = body?.holder_type === "individual" ? "individual" : "business";
    const bankAccountType = body?.bank_account_type === "savings" ? "savings" : "checking";
    const routingNumber = String(body?.routing_number ?? "").replace(/\D/g, "");
    const accountNumber = String(body?.account_number ?? "").replace(/\D/g, "");

    if (!tenantId) return json({ error: "tenant_id is required" }, 400);
    if (holderName.length < 2 || holderName.length > 128) {
      return json({ error: "Enter the account holder name as it appears at the bank." }, 400);
    }
    if (!DIGITS.test(routingNumber) || routingNumber.length !== 9) {
      return json({ error: "Routing number must be exactly 9 digits." }, 400);
    }
    if (!DIGITS.test(accountNumber) || accountNumber.length < 4 || accountNumber.length > 17) {
      return json({ error: "Account number must be between 4 and 17 digits." }, 400);
    }

    const caller = await requireMoovCaller(req, tenantId, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("id, provider_account_id")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = (account as any)?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "Set up the payment account first." }, 409);

    let created: any;
    try {
      created = await moovFetch<any>(`/accounts/${accountId}/bank-accounts`, {
        method: "POST",
        scopes: scopes.bankAccountsWrite(accountId),
        body: {
          account: {
            holderName,
            holderType,
            accountNumber,
            routingNumber,
            bankAccountType,
          },
        },
      });
    } catch (e) {
      console.error("[moov-bank-account-add] attach failed", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }

    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;
    if (!bankAccountId) return json({ error: "The provider did not return a bank account id." }, 502);

    const bankName = created?.bankName ?? null;
    const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
    const status = String(created?.status ?? "new").toLowerCase();

    const { data: method, error: methodErr } = await supabase
      .from("payment_provider_methods")
      .upsert(
        {
          tenant_id: tenantId,
          provider: "moov",
          environment,
          provider_account_id: accountId,
          provider_bank_account_id: bankAccountId,
          bank_name: bankName,
          account_type: bankAccountType,
          last_four: lastFour,
          holder_name: holderName,
          verification_status: status === "verified" ? "verified" : "unverified",
          connection_status: "connected",
          can_send: true,
          can_receive: true,
          is_default: true,
          connected_at: new Date().toISOString(),
          provider_metadata: sanitize({ status, source: "manual_entry" }),
        },
        { onConflict: "provider,environment,provider_bank_account_id" },
      )
      .select()
      .maybeSingle();

    if (methodErr) {
      console.error("[moov-bank-account-add] persist failed", methodErr.message);
      return json({ error: methodErr.message }, 500);
    }

    await supabase
      .from("payment_provider_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", (account as any).id);

    await logPaymentEvent(supabase, {
      tenant_id: tenantId,
      event_type: "bank_account.connected",
      new_status: status,
      environment,
      provider_metadata: sanitize({ bankName, lastFour, source: "manual_entry", by: userId }),
    });

    return json({
      success: true,
      payment_method_id: method?.id ?? null,
      bank_account_id: bankAccountId,
      bank_name: bankName,
      last_four: lastFour,
      status,
    });
  } catch (e) {
    console.error("[moov-bank-account-add]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
