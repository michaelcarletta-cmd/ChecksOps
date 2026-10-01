import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid } from "./plaidClient.ts";
import { moovFetch, scopes, safeLastFour, moovConfigured } from "./moovClient.ts";
import { MOOV_CAPABILITIES_API_VERSION, RECIPIENT_CAPABILITIES } from "./moovCapabilities.ts";
import { logPaymentEvent, sanitize, moovGloballyEnabled } from "./moovGuard.ts";

/**
 * Shared core of the Plaid -> Moov bank bridge.
 *
 * Moov speaks Plaid natively: a Plaid processor token minted for the "moov"
 * processor can be attached directly as a verified bank account, so a bank that
 * was linked once through Plaid Link never has to be re-verified (no
 * micro-deposits, no Authentecheck, no Actum).
 *
 * Both the manual `moov-plaid-bridge` endpoint and the automatic post-Link
 * bridge in `plaid-exchange` run this exact code, so the two paths can never
 * drift. Raw account/routing numbers are never read or logged here.
 */

export interface BridgeInput {
  supabase: SupabaseClient;
  tenantId: string;
  environment: string;
  /** "recipient" = payee gets their own Moov account; "tenant" = org funding bank. */
  mode: "recipient" | "tenant";
  /** Bridge this specific stakeholder_accounts row; otherwise the newest Plaid bank. */
  stakeholderAccountId?: string | null;
  userId?: string | null;
}

export interface BridgeResult {
  mode: "recipient" | "tenant";
  recipient_id: string | null;
  provider_account_id: string;
  bank_name: string | null;
  last_four: string | null;
  status: string;
}

/** Thrown with an HTTP status so callers can map it onto a response. */
export class BridgeError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

/** True when the Moov rail may run at all for this organization. */
export async function moovBridgeAvailable(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  if (!moovGloballyEnabled() || !moovConfigured()) return false;
  const { data } = await supabase
    .from("tenants")
    .select("moov_allowlisted")
    .eq("id", tenantId)
    .maybeSingle();
  return !!(data as any)?.moov_allowlisted;
}

async function attachBank(moovAccountId: string, processorToken: string) {
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

export async function bridgePlaidBankToMoov(input: BridgeInput): Promise<BridgeResult> {
  const { supabase, tenantId, environment, mode, stakeholderAccountId, userId } = input;
  const isRecipientMode = mode === "recipient";

  /* ---------------- Locate the Plaid-linked bank ---------------- */

  let q = supabase
    .from("stakeholder_accounts")
    .select(
      "id, nickname, custname, account_type, homeowner_name, homeowner_email, plaid_access_token, plaid_account_id, plaid_institution_name, plaid_account_mask",
    )
    .eq("tenant_id", tenantId)
    .eq("verification_source", "plaid")
    .not("plaid_access_token", "is", null)
    .order("verified_at", { ascending: false })
    .limit(1);
  if (stakeholderAccountId) q = q.eq("id", stakeholderAccountId);

  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) throw new BridgeError(rowsErr.message, 500);
  const bank = rows?.[0] as any;

  if (!bank?.plaid_access_token || !bank?.plaid_account_id) {
    throw new BridgeError("No connected bank was found to bridge. Link a bank account first.", 409);
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
        throw new BridgeError(
          "This payee is a ChecksOps organization — pay their own connected account instead of bridging a bank.",
          409,
        );
      }
    }

    // Reuse an existing external recipient, matched by bank row first, email second.
    let recipient: any = null;
    const { data: byBank } = await supabase
      .from("external_payment_recipients")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .eq("stakeholder_account_id", bank.id)
      .maybeSingle();
    recipient = byBank ?? null;

    if (!recipient && payeeEmail) {
      const { data: byEmail } = await supabase
        .from("external_payment_recipients")
        .select("*")
        .eq("tenant_id", tenantId)
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
          tenant_id: tenantId,
          provider: "moov",
          environment,
          display_name: payeeName,
          email: payeeEmail,
          recipient_type: "individual",
          relationship: bank.account_type === "homeowner" ? "homeowner" : "one_time",
          onboarding_status: "not_started",
          stakeholder_account_id: bank.id,
          created_by: userId ?? null,
        })
        .select()
        .single();
      if (insErr) throw new BridgeError(insErr.message, 500);
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
        apiVersion: MOOV_CAPABILITIES_API_VERSION,
        body: {
          accountType: "individual",
          profile: {
            individual: {
              name: { firstName: first, lastName: rest.join(" ") || first },
              email: payeeEmail ?? undefined,
            },
          },
          capabilities: [...RECIPIENT_CAPABILITIES],
          foreignID: recipient.id,
          metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: tenantId },
        },
      });
      moovAccountId = created?.accountID ?? created?.accountId ?? undefined;
      if (!moovAccountId) {
        throw new BridgeError("The payment provider did not return an account for this payee.", 502);
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
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    moovAccountId = (acct as any)?.provider_account_id ?? undefined;
    providerAccountRowId = (acct as any)?.id ?? undefined;
    if (!moovAccountId) throw new BridgeError("Set up the payment account first.", 409);
  }

  /* ---------------- Mint a processor token and attach the bank ---------------- */

  const processor = await callPlaid<{ processor_token: string }>("/processor/token/create", {
    access_token: bank.plaid_access_token,
    account_id: bank.plaid_account_id,
    processor: "moov",
  });

  const created = await attachBank(moovAccountId!, processor.processor_token);

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

    // Mirror onto the bank row so the disbursement dropdown shows the payee as
    // provider-connected without exposing any banking detail.
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
    tenant_id: tenantId,
    recipient_id: recipientId ?? null,
    event_type: isRecipientMode ? "recipient.bank_bridged_from_plaid" : "bank_bridged_from_plaid",
    new_status: status,
    environment,
    provider_metadata: sanitize({ bankName, lastFour, source: "plaid_processor_token" }),
  });

  return {
    mode: isRecipientMode ? "recipient" : "tenant",
    recipient_id: recipientId ?? null,
    provider_account_id: moovAccountId!,
    bank_name: bankName,
    last_four: lastFour,
    status,
  };
}
