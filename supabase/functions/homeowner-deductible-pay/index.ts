// PUBLIC, ledger-token authenticated deductible payment.
//
// The homeowner pays their deductible straight to the contractor's balance
// with a bank (ACH) debit. Bank numbers are forwarded to the provider and are
// never stored or logged — only bank name and last four are retained.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  moovFetch,
  moovConfigured,
  moovEnvironment,
  safeLastFour,
  scopes,
  facilitatorAccountId,
  normalizeTransferStatus,
} from "../_shared/moovClient.ts";
import { COLLECT_ACH_CAPABILITIES, MOOV_CAPABILITIES_API_VERSION } from "../_shared/moovCapabilities.ts";
import { corsHeaders, json, sanitize, logPaymentEvent } from "../_shared/moovGuard.ts";
import { syncWallet } from "../_shared/moovWallet.ts";

const DIGITS = /^\d+$/;

const AUTH_TEXT =
  "I authorize a one-time electronic debit (ACH) from the bank account provided " +
  "for the deductible amount shown. I understand the debit may take several " +
  "business days to settle and that returned payments may incur a fee.";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "Online payments are not enabled." }, 403);
    }
    if (!moovConfigured()) return json({ error: "Payment provider is not configured." }, 503);

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    const amount = Number(body?.amount ?? 0);
    const holderName = String(body?.holder_name ?? "").trim();
    const bankAccountType = body?.bank_account_type === "savings" ? "savings" : "checking";
    const routingNumber = String(body?.routing_number ?? "").replace(/\D/g, "");
    const accountNumber = String(body?.account_number ?? "").replace(/\D/g, "");
    const authorized = body?.authorized === true;

    if (!token || token.length < 8) return json({ error: "This link is not valid." }, 400);
    if (!authorized) return json({ error: "You must authorize the bank debit to continue." }, 400);
    if (holderName.length < 2 || holderName.length > 128) {
      return json({ error: "Enter the account holder name as it appears at the bank." }, 400);
    }
    if (!DIGITS.test(routingNumber) || routingNumber.length !== 9) {
      return json({ error: "Routing number must be exactly 9 digits." }, 400);
    }
    if (!DIGITS.test(accountNumber) || accountNumber.length < 4 || accountNumber.length > 17) {
      return json({ error: "Account number must be between 4 and 17 digits." }, 400);
    }
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return json({ error: "Enter a payment amount greater than zero." }, 400);
    }

    const environment = moovEnvironment();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: tok } = await supabase
      .from("homeowner_ledger_tokens")
      .select("id, tenant_id, claim_id, case_id, homeowner_name, homeowner_email, revoked_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!tok) return json({ error: "This link is not valid." }, 404);
    if (tok.revoked_at) return json({ error: "This link is no longer active." }, 410);
    if (tok.expires_at && new Date(tok.expires_at) < new Date()) {
      return json({ error: "This link has expired." }, 410);
    }
    if (!tok.claim_id) return json({ error: "This claim is not ready for payments yet." }, 409);

    // Plan + remaining deductible
    const { data: plan } = await supabase
      .from("claim_project_plans")
      .select("id, deductible_amount, allow_deductible_payment, share_with_homeowner")
      .eq("claim_id", tok.claim_id)
      .maybeSingle();

    if (!plan?.allow_deductible_payment) {
      return json({ error: "Online deductible payments are not enabled for this project." }, 409);
    }
    const deductible = Number(plan.deductible_amount ?? 0);
    if (deductible <= 0) return json({ error: "No deductible is set for this project." }, 409);

    const { data: priorRows } = await supabase
      .from("homeowner_deductible_payments")
      .select("amount, status")
      .eq("claim_id", tok.claim_id);
    const paid = (priorRows ?? [])
      .filter((r: any) => !["failed", "returned", "canceled"].includes(String(r.status)))
      .reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
    const remainingCents = Math.round(deductible * 100) - Math.round(paid * 100);
    if (remainingCents <= 0) return json({ error: "Your deductible is already paid." }, 409);
    if (amountCents > remainingCents) {
      return json({ error: "That amount is more than the deductible balance due." }, 400);
    }

    // Contractor (tenant) destination balance
    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status")
      .eq("tenant_id", tok.tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) {
      return json({ error: "Your contractor has not finished payment setup yet." }, 409);
    }
    const wallet = await syncWallet(supabase, {
      tenantId: tok.tenant_id,
      accountId: account.provider_account_id,
      environment,
    });
    if (!wallet.provider_payment_method_id) {
      return json({ error: "Your contractor cannot receive payments yet." }, 409);
    }

    // Payer account on the provider (reused per claim + homeowner)
    const payerName = holderName;
    let { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, provider_account_id")
      .eq("tenant_id", tok.tenant_id)
      .eq("claim_id", tok.claim_id)
      .eq("relationship", "homeowner_payer")
      .eq("environment", environment)
      .maybeSingle();

    if (!recipient) {
      const { data: created, error: insErr } = await supabase
        .from("external_payment_recipients")
        .insert({
          tenant_id: tok.tenant_id,
          provider: "moov",
          environment,
          display_name: tok.homeowner_name || payerName,
          email: tok.homeowner_email ?? null,
          recipient_type: "individual",
          relationship: "homeowner_payer",
          claim_id: tok.claim_id,
          onboarding_status: "not_started",
        })
        .select("id, provider_account_id")
        .single();
      if (insErr) return json({ error: insErr.message }, 500);
      recipient = created;
    }

    if (!recipient!.provider_account_id) {
      const [first, ...rest] = payerName.split(/\s+/);
      const acc = await moovFetch<any>("/accounts", {
        method: "POST",
        scopes: scopes.accountsWrite(),
        idempotencyKey: `checksops-ho-payer-${environment}-${recipient!.id}`,
        apiVersion: MOOV_CAPABILITIES_API_VERSION,
        body: {
          accountType: "individual",
          profile: {
            individual: {
              name: { firstName: first, lastName: rest.join(" ") || first },
              email: tok.homeowner_email ?? undefined,
            },
          },
          capabilities: [...COLLECT_ACH_CAPABILITIES],
          foreignID: recipient!.id,
          metadata: {
            checksops_recipient_id: recipient!.id,
            checksops_tenant_id: tok.tenant_id,
            purpose: "homeowner_deductible",
          },
        },
      }).catch((e) => {
        console.error("[homeowner-deductible-pay] account create failed", (e as Error).message);
        return null;
      });
      const accountId = acc?.accountID ?? acc?.accountId ?? null;
      if (!accountId) return json({ error: "Could not start the payment. Please try again." }, 502);
      await supabase
        .from("external_payment_recipients")
        .update({ provider_account_id: accountId, onboarding_status: "awaiting_bank" })
        .eq("id", recipient!.id);
      recipient!.provider_account_id = accountId;
    }

    const payerAccountId = recipient!.provider_account_id as string;

    // Attach the bank account (numbers never persisted on our side)
    let bank: any;
    try {
      bank = await moovFetch<any>(`/accounts/${payerAccountId}/bank-accounts`, {
        method: "POST",
        scopes: scopes.bankAccountsWrite(payerAccountId),
        body: {
          account: {
            holderName,
            holderType: "individual",
            accountNumber,
            routingNumber,
            bankAccountType,
          },
        },
      });
    } catch (e) {
      console.error("[homeowner-deductible-pay] bank attach failed", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }

    const bankAccountId = bank?.bankAccountID ?? bank?.bankAccountId ?? null;
    if (!bankAccountId) return json({ error: "Your bank could not be linked." }, 502);
    const bankName = bank?.bankName ?? null;
    const lastFour = bank?.lastFourAccountNumber ?? safeLastFour(accountNumber);

    // Resolve the debit-collect payment method for that bank account
    const methods = await moovFetch<any[]>(`/accounts/${payerAccountId}/payment-methods`, {
      scopes: scopes.paymentMethodsRead(payerAccountId),
    }).catch(() => [] as any[]);
    const source = (methods ?? []).find((m: any) => {
      const owner = m?.bankAccount?.bankAccountID ?? m?.bankAccount?.bankAccountId ?? null;
      return String(m?.paymentMethodType ?? "") === "ach-debit-collect" &&
        (!owner || owner === bankAccountId);
    });
    const sourceMethodId = source?.paymentMethodID ?? source?.paymentMethodId ?? null;
    if (!sourceMethodId) {
      return json({ error: "This bank account cannot be debited yet. Please try another account." }, 409);
    }

    const idempotencyKey = `ho-deductible:${tok.claim_id}:${amountCents}:${lastFour}:${Date.now()}`;

    const { data: record, error: recErr } = await supabase
      .from("homeowner_deductible_payments")
      .insert({
        tenant_id: tok.tenant_id,
        claim_id: tok.claim_id,
        case_id: (tok as any).case_id ?? null,
        token_id: tok.id,
        recipient_id: recipient!.id,
        amount: amountCents / 100,
        status: "initiating",
        environment,
        idempotency_key: idempotencyKey,
        bank_name: bankName,
        bank_last_four: lastFour,
        authorization_accepted_at: new Date().toISOString(),
        authorization_text: AUTH_TEXT,
        payer_name: payerName,
        payer_email: tok.homeowner_email ?? null,
      })
      .select()
      .single();
    if (recErr) return json({ error: recErr.message }, 500);

    let transfer: any;
    try {
      const facilitatorId = await facilitatorAccountId(account.provider_account_id);
      transfer = await moovFetch<any>(`/accounts/${facilitatorId}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(facilitatorId),
        idempotencyKey: `checksops-ho-deductible-${record.id}`,
        body: {
          source: { paymentMethodID: sourceMethodId },
          destination: { paymentMethodID: wallet.provider_payment_method_id },
          amount: { currency: "USD", value: amountCents },
          description: "Deductible payment".slice(0, 128),
          metadata: {
            checksops_deductible_payment_id: record.id,
            checksops_tenant_id: tok.tenant_id,
            checksops_claim_id: tok.claim_id,
          },
        },
      });
    } catch (e) {
      await supabase
        .from("homeowner_deductible_payments")
        .update({ status: "failed", failure_reason: (e as Error).message })
        .eq("id", record.id);
      console.error("[homeowner-deductible-pay] transfer failed", (e as Error).message);
      return json({ error: "The payment could not be started. Please check your bank details." }, 502);
    }

    const providerTransferId = transfer?.transferID ?? transfer?.transferId ?? null;
    const status = normalizeTransferStatus(transfer?.status);
    const mapped = status === "completed" ? "completed" : status === "failed" ? "failed" : "pending";

    await supabase
      .from("homeowner_deductible_payments")
      .update({
        status: mapped,
        provider_transfer_id: providerTransferId,
        provider_status: transfer?.status ?? null,
        completed_at: mapped === "completed" ? new Date().toISOString() : null,
      })
      .eq("id", record.id);

    await supabase.from("homeowner_ledger_events").insert(sanitize({
      tenant_id: tok.tenant_id,
      claim_id: tok.claim_id,
      event_type: "deductible_payment",
      occurred_at: new Date().toISOString(),
      amount: amountCents / 100,
      actor_label: tok.homeowner_name || "Homeowner",
      payload_json: { bank_last_four: lastFour, status: mapped },
    })).then(() => {}, () => {});

    await logPaymentEvent(supabase, {
      tenant_id: tok.tenant_id,
      provider_transfer_id: providerTransferId,
      event_type: "homeowner.deductible.initiated",
      new_status: mapped,
      environment,
    });

    return json({
      success: true,
      status: mapped,
      amount: amountCents / 100,
      bank_name: bankName,
      last_four: lastFour,
    });
  } catch (e) {
    console.error("[homeowner-deductible-pay]", (e as Error).message);
    return json({ error: "Something went wrong starting your payment." }, 500);
  }
});
