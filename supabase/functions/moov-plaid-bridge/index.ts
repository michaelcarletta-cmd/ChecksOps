import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callPlaid } from "../_shared/plaidClient.ts";
import { moovFetch, scopes, safeLastFour } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller, logPaymentEvent, sanitize } from "../_shared/moovGuard.ts";

/**
 * One-click bridge from an EXISTING Plaid-linked bank to Moov.
 *
 * Two modes, both driven off a `stakeholder_accounts` row that already holds a
 * Plaid item — nobody re-enters bank details, and raw account/routing numbers
 * are never read or stored here:
 *
 *   "tenant"    — attaches the organization's own funding bank to its Moov
 *                 account (admin only). This is the payer side.
 *   "recipient" — a homeowner / sub / one-time payee who linked their bank via
 *                 the Plaid email. We create (or reuse) their Moov recipient
 *                 account and attach that same bank, so they become payable on
 *                 the Moov rail without a second setup link.
 *
 * The Plaid and Actum rails are untouched: the Plaid item keeps working exactly
 * as before, we only mint an additional processor token for Moov.
 */

async function bridgeBank(moovAccountId: string, processorToken: string) {
  try {
    return await moovFetch<any>(`/accounts/${moovAccountId}/bank-accounts`, {
      method: "POST",
      scopes: scopes.bankAccountsWrite(moovAccountId),
      body: { plaid: { token: processorToken } },
    });
  } catch (_e) {
    // Older payload shape accepted by Moov.
    return await moovFetch<any>(`/accounts/${moovAccountId}/bank-accounts`, {
      method: "POST",
      scopes: scopes.bankAccountsWrite(moovAccountId),
      body: { plaidToken: processorToken },
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, stakeholder_account_id, mode } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    // The recipient path is a normal day-to-day action for anyone working the
    // check; only the org's own funding bank is admin-gated.
    const isRecipientMode = mode === "recipient";
    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: !isRecipientMode });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    /* ---------------- Locate the Plaid-linked bank ---------------- */

    let q = supabase
      .from("stakeholder_accounts")
      .select(
        "id, nickname, custname, account_type, homeowner_name, homeowner_email, plaid_access_token, plaid_account_id, plaid_institution_name, plaid_account_mask",
      )
      .eq("tenant_id", tenant_id)
      .eq("verification_source", "plaid")
      .not("plaid_access_token", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1);
    if (stakeholder_account_id) q = q.eq("id", stakeholder_account_id);

    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) throw new Error(rowsErr.message);
    const bank = rows?.[0] as any;

    if (!bank?.plaid_access_token || !bank?.plaid_account_id) {
      return json(
        { error: "No connected bank was found to bridge. Link a bank account first." },
        409,
      );
    }

    /* ---------------- Resolve the destination Moov account ---------------- */

    let moovAccountId: string | undefined;
    let providerAccountRowId: string | undefined;
    let recipientId: string | undefined;

    if (isRecipientMode) {
      const payeeName = bank.homeowner_name ?? bank.custname ?? bank.nickname ?? "Recipient";
      const payeeEmail = bank.homeowner_email ?? null;

      // Never create a second provider account for an org that already has one.
      if (payeeEmail) {
        const { data: memberTenant } = await supabase
          .from("tenants")
          .select("id, name")
          .ilike("email_reply_to", String(payeeEmail).trim())
          .maybeSingle();
        if (memberTenant) {
          return json({
            error:
              "This payee is a ChecksOps organization — pay their own connected account instead of bridging a bank.",
          }, 409);
        }
      }

      // Reuse an existing external recipient for this tenant, matched by the
      // bank row first and email second.
      let recipient: any = null;
      const { data: byBank } = await supabase
        .from("external_payment_recipients")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("provider", "moov")
        .eq("environment", environment)
        .eq("stakeholder_account_id", bank.id)
        .maybeSingle();
      recipient = byBank ?? null;

      if (!recipient && payeeEmail) {
        const { data: byEmail } = await supabase
          .from("external_payment_recipients")
          .select("*")
          .eq("tenant_id", tenant_id)
          .eq("provider", "moov")
          .eq("environment", environment)
          .ilike("email", String(payeeEmail).trim())
          .maybeSingle();
        recipient = byEmail ?? null;
      }

      if (!recipient) {
        const { data: inserted, error: insErr } = await supabase
          .from("external_payment_recipients")
          .insert({
            tenant_id,
            provider: "moov",
            environment,
            display_name: payeeName,
            email: payeeEmail,
            recipient_type: "individual",
            relationship: bank.account_type === "homeowner" ? "homeowner" : "one_time",
            onboarding_status: "not_started",
            stakeholder_account_id: bank.id,
            created_by: userId,
          })
          .select()
          .single();
        if (insErr) return json({ error: insErr.message }, 500);
        recipient = inserted;
      }

      recipientId = recipient.id;
      moovAccountId = recipient.provider_account_id ?? undefined;

      // Create the Moov recipient account on first bridge.
      if (!moovAccountId) {
        const [first, ...rest] = String(payeeName).trim().split(/\s+/);
        const created = await moovFetch<any>("/accounts", {
          method: "POST",
          scopes: scopes.accountsWrite(),
          idempotencyKey: `checksops-recipient-${environment}-${recipient.id}`,
          body: {
            accountType: "individual",
            profile: {
              individual: {
                name: { firstName: first, lastName: rest.join(" ") || first },
                email: payeeEmail ?? undefined,
              },
            },
            capabilities: ["send-funds"],
            foreignID: recipient.id,
            metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: tenant_id },
          },
        });
        moovAccountId = created?.accountID ?? created?.accountId ?? undefined;
        if (!moovAccountId) {
          return json({ error: "The payment provider did not return an account for this payee." }, 502);
        }
        await supabase
          .from("external_payment_recipients")
          .update({ provider_account_id: moovAccountId, onboarding_status: "awaiting_bank" })
          .eq("id", recipient.id);
      }
    } else {
      const { data: acct } = await supabase
        .from("payment_provider_accounts")
        .select("id, provider_account_id")
        .eq("tenant_id", tenant_id)
        .eq("provider", "moov")
        .eq("environment", environment)
        .maybeSingle();

      moovAccountId = (acct as any)?.provider_account_id ?? undefined;
      providerAccountRowId = (acct as any)?.id ?? undefined;
      if (!moovAccountId) {
        return json({ error: "Set up the payment account first." }, 409);
      }
    }

    /* ---------------- Mint a processor token and attach the bank ---------------- */

    const processor = await callPlaid<{ processor_token: string }>(
      "/processor/token/create",
      {
        access_token: bank.plaid_access_token,
        account_id: bank.plaid_account_id,
        processor: "moov",
      },
    );

    const created = await bridgeBank(moovAccountId!, processor.processor_token);

    const bankName = created?.bankName ?? bank.plaid_institution_name ?? null;
    const lastFour = safeLastFour(created?.lastFourAccountNumber) ?? bank.plaid_account_mask ?? null;
    const status = String(created?.status ?? "pending").toLowerCase();
    const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;

    /* ---------------- Persist ---------------- */

    if (isRecipientMode) {
      await supabase
        .from("external_payment_recipients")
        .update({
          onboarding_status: status === "verified" ? "ready" : "bank_pending",
          provider_bank_name: bankName,
          provider_last_four: lastFour,
          bank_linked_at: new Date().toISOString(),
          stakeholder_account_id: bank.id,
        })
        .eq("id", recipientId!);

      // Mirror onto the bank row so the disbursement dropdown shows the payee
      // as provider-connected without exposing any banking detail.
      await supabase
        .from("stakeholder_accounts")
        .update({
          provider: "moov",
          provider_environment: environment,
          provider_account_id: moovAccountId,
          provider_bank_account_id: bankAccountId,
          provider_bank_name: bankName,
          provider_last_four: lastFour,
        })
        .eq("id", bank.id);
    } else if (providerAccountRowId) {
      await supabase
        .from("payment_provider_accounts")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", providerAccountRowId);
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: recipientId ?? null,
      event_type: isRecipientMode ? "recipient.bank_bridged_from_plaid" : "bank_bridged_from_plaid",
      new_status: status,
      environment,
      provider_metadata: sanitize({ bankName, lastFour, source: "plaid_processor_token" }),
    });

    return json({
      success: true,
      mode: isRecipientMode ? "recipient" : "tenant",
      recipient_id: recipientId ?? null,
      provider_account_id: moovAccountId,
      bank_name: bankName,
      last_four: lastFour,
      status,
    });
  } catch (e) {
    console.error("[moov-plaid-bridge]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
