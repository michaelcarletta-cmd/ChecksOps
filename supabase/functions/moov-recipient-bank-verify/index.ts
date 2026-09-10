import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { MoovError, moovFetch, bindMoovEnvironment, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";
import {
  RECIPIENT_VERIFY_MAX_ATTEMPTS,
  identityRequirementsOutstanding,
  initiateAlreadyOpenError,
  interpretRecipientBankVerification,
  liveBankVerified,
  liveTosAccepted,
  moovInstantVerifyBody,
  providerVerifySuccessIsNotComplete,
  recipientBankVerifyBlocked,
  rejectBrowserBankSubstitution,
  recipientOnboardingCompleteFromMoov,
  shouldInitiateInstantMicroDeposit,
  tosRequirementOutstanding,
} from "../_shared/recipientTosPolicy.ts";

/**
 * PUBLIC, token-authenticated instant micro-deposit verification for the
 * branded recipient page. Reuses Moov's existing POST/PUT /verify contract.
 *
 * The $0.01 credit is Moov's bank-ownership proof, not a ChecksOps transfer.
 * Account and bank ids are derived from the secure link + live Moov list.
 * Browser-supplied account/bank ids cannot switch the target.
 */

const listOf = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  return [];
};

async function readLiveVerification(accountId: string, bankAccountId: string) {
  try {
    return await moovFetch<any>(
      `/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`,
      { scopes: scopes.bankAccountsRead(accountId) },
    );
  } catch {
    try {
      return await moovFetch<any>(
        `/accounts/${accountId}/bank-accounts/${bankAccountId}/verification`,
        { scopes: scopes.bankAccountsRead(accountId) },
      );
    } catch {
      return null;
    }
  }
}

function mapConfirmError(e: unknown): { code: string; message: string } {
  const err = e as MoovError;
  const raw = `${err?.message ?? ""} ${JSON.stringify((err as any)?.details ?? "")}`.toLowerCase();
  if (raw.includes("max") && raw.includes("attempt")) {
    return {
      code: "max_attempts_exceeded",
      message: "Too many incorrect attempts. Restart verification to receive a new deposit code.",
    };
  }
  if (raw.includes("expired")) {
    return {
      code: "verification_expired",
      message: "This verification expired. Restart verification to receive a new deposit code.",
    };
  }
  if (err?.status === 404) {
    return {
      code: "verification_not_found",
      message: "No open verification for this bank account. Start verification to receive a deposit code.",
    };
  }
  if (err?.status === 409 || err?.status === 422 || err?.status === 400) {
    return {
      code: "invalid_code",
      message: "That code did not match. Check the $0.01 deposit descriptor and try again.",
    };
  }
  return {
    code: "provider_error",
    message: "The payment provider could not complete verification. Please try again shortly.",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    const action = String(body?.action ?? "").toLowerCase();
    if (!token) return json({ error: "token is required" }, 400);
    if (action !== "initiate" && action !== "confirm") {
      return json({ error: "action must be initiate or confirm." }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment, provider_bank_name, provider_last_four")
      .eq("secure_token", token)
      .maybeSingle();

    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    const accountId = recipient.provider_account_id as string | null;
    if (!accountId) return json({ error: "This payment setup is not ready yet." }, 409);

    bindMoovEnvironment(String(recipient.environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) return json({ error: "Payment provider is not configured." }, 503);

    const account = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    let capabilities: any[] = [];
    let capsOk = false;
    try {
      const caps = await moovFetch<any>(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId) });
      capabilities = listOf(caps);
      capsOk = true;
    } catch { /* unread capabilities fail closed for ToS/KYC gates */ }
    const blocked = recipientBankVerifyBlocked({
      tosAccepted: liveTosAccepted(account),
      tosOutstanding: capsOk ? tosRequirementOutstanding(capabilities) : true,
      identityOutstanding: capsOk ? identityRequirementsOutstanding(capabilities) : [],
    });
    if (blocked) return json({ error: blocked.error, message: blocked.message }, blocked.statusCode);

    let banks: any[] = [];
    try {
      const payload = await moovFetch<any>(`/accounts/${accountId}/bank-accounts`, { scopes: scopes.bankAccountsRead(accountId) });
      banks = listOf(payload);
    } catch {
      return json({
        error: "moov_bank_list_failed",
        message: "Could not load existing bank accounts. Verification was not started.",
      }, 502);
    }
    const liveBank = banks[0];
    if (!liveBank) {
      return json({ error: "bank_required", message: "Connect a bank account before verification." }, 409);
    }
    const liveBankId = String(liveBank.bankAccountID ?? liveBank.bankAccountId ?? "");
    if (!liveBankId) {
      return json({ error: "moov_bank_list_failed", message: "Could not identify the existing bank account." }, 502);
    }

    const swapped = rejectBrowserBankSubstitution({
      recipientAccountId: accountId,
      liveBankAccountId: liveBankId,
      requestedAccountId: body.account_id ?? body.accountId ?? null,
      requestedBankAccountId: body.bank_account_id ?? body.bankAccountId ?? null,
    });
    if (swapped) return json({ error: swapped.error }, swapped.statusCode);

    const liveVerify = await readLiveVerification(accountId, liveBankId);
    const interpreted = interpretRecipientBankVerification({ bank: liveBank, verification: liveVerify });

    if (action === "initiate") {
      if (interpreted.verified) {
        return json({
          success: true,
          already_verified: true,
          complete: recipientOnboardingCompleteFromMoov({
            account, banks, capabilities, capabilitiesReadOk: capsOk,
          }),
          bank_status: interpreted.bank_status,
          initiated: false,
          account_id: accountId,
          environment,
        });
      }

      if (!shouldInitiateInstantMicroDeposit({ bank: liveBank, verification: liveVerify })) {
        return json({
          success: true,
          already_initiated: true,
          initiated: interpreted.initiated,
          can_confirm: interpreted.can_confirm,
          bank_status: interpreted.bank_status,
          verification_status: interpreted.verification_status,
          complete: false,
          account_id: accountId,
          environment,
        });
      }

      try {
        await moovFetch<any>(
          `/accounts/${accountId}/bank-accounts/${liveBankId}/verify`,
          { method: "POST", scopes: scopes.bankAccountsWrite(accountId) },
        );
      } catch (e) {
        if (!initiateAlreadyOpenError((e as Error).message)) {
          console.error("[moov-recipient-bank-verify] initiate", (e as Error).message);
          return json({
            error: "initiate_failed",
            message: "Could not start bank verification with the payment provider.",
          }, 502);
        }
      }

      const refreshedBank = await moovFetch<any>(
        `/accounts/${accountId}/bank-accounts/${liveBankId}`,
        { scopes: scopes.bankAccountsRead(accountId) },
      ).catch(() => liveBank);
      const refreshedVerify = await readLiveVerification(accountId, liveBankId);
      const after = interpretRecipientBankVerification({ bank: refreshedBank, verification: refreshedVerify });

      const { error: verifyRowErr } = await supabase.from("payment_method_verifications").insert({
        tenant_id: recipient.tenant_id,
        external_recipient_id: recipient.id,
        provider: "moov",
        environment,
        provider_account_id: accountId,
        provider_bank_account_id: liveBankId,
        method: "micro_deposit",
        status: "pending",
        attempts: 0,
      });
      if (verifyRowErr) {
        console.error("[moov-recipient-bank-verify] verification row", verifyRowErr.message);
      }

      await supabase.from("payment_event_log").insert(sanitize({
        tenant_id: recipient.tenant_id,
        event_type: "recipient.bank_account.micro_deposit.initiated",
        new_status: after.verification_status,
        environment,
        provider_metadata: { recipient_id: recipient.id, source: "recipient_link" },
      }));

      return json({
        success: true,
        initiated: after.initiated || true,
        can_confirm: after.can_confirm,
        already_initiated: false,
        bank_status: after.bank_status,
        verification_status: after.verification_status,
        complete: liveBankVerified([refreshedBank]),
        account_id: accountId,
        environment,
      });
    }

    const verifyBody = moovInstantVerifyBody(body?.code ?? body?.verification_code);
    if (!verifyBody) return json({ error: "Enter the 4-digit verification code." }, 400);

    const { data: openRow } = await supabase
      .from("payment_method_verifications")
      .select("id, attempts, max_attempts, status")
      .eq("external_recipient_id", recipient.id)
      .eq("provider_bank_account_id", liveBankId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const maxAttempts = Number(openRow?.max_attempts ?? RECIPIENT_VERIFY_MAX_ATTEMPTS);
    const priorAttempts = Number(openRow?.attempts ?? 0);
    if (openRow && priorAttempts >= maxAttempts) {
      return json({
        error: "max_attempts_exceeded",
        requires_restart: true,
        message: "Too many incorrect attempts. Restart verification to receive a new deposit code.",
      }, 409);
    }

    if (interpreted.verified) {
      return json({
        success: true,
        already_verified: true,
        complete: recipientOnboardingCompleteFromMoov({
          account, banks, capabilities, capabilitiesReadOk: capsOk,
        }),
        bank_status: "verified",
        account_id: accountId,
        environment,
      });
    }

    try {
      await moovFetch<any>(
        `/accounts/${accountId}/bank-accounts/${liveBankId}/verify`,
        {
          method: "PUT",
          scopes: scopes.bankAccountsWrite(accountId),
          body: verifyBody,
        },
      );
    } catch (e) {
      const mapped = mapConfirmError(e);
      const attempts = priorAttempts + 1;
      const exhausted = attempts >= maxAttempts
        || mapped.code === "max_attempts_exceeded"
        || mapped.code === "verification_expired";
      if (openRow?.id) {
        await supabase.from("payment_method_verifications").update({
          attempts,
          status: exhausted
            ? (mapped.code === "verification_expired" ? "failed" : "max_attempts_exceeded")
            : "pending",
          failure_reason: mapped.code,
        }).eq("id", openRow.id);
      }
      await supabase.from("payment_event_log").insert(sanitize({
        tenant_id: recipient.tenant_id,
        event_type: "recipient.bank_account.micro_deposit.failed",
        new_status: mapped.code,
        environment,
        provider_metadata: { recipient_id: recipient.id, attempts },
      }));
      return json({
        error: exhausted ? mapped.code : "verification_failed",
        requires_restart: exhausted,
        message: mapped.message,
        attempts_remaining: Math.max(0, maxAttempts - attempts),
      }, 409);
    }

    const refreshed = await moovFetch<any>(
      `/accounts/${accountId}/bank-accounts/${liveBankId}`,
      { scopes: scopes.bankAccountsRead(accountId) },
    ).catch(() => null);
    if (!refreshed) {
      return json({
        error: "moov_bank_get_failed",
        message: "The payment provider did not confirm bank verification.",
      }, 502);
    }

    const verified = liveBankVerified([refreshed]);
    if (providerVerifySuccessIsNotComplete({ httpOk: true, bank: refreshed }) || !verified) {
      return json({
        error: "bank_not_verified",
        message: "The payment provider did not mark this bank as verified.",
        complete: false,
      }, 502);
    }

    const refreshedBanks = [refreshed, ...banks.slice(1)];
    const complete = recipientOnboardingCompleteFromMoov({
      account,
      banks: refreshedBanks,
      capabilities,
      capabilitiesReadOk: capsOk,
    });

    if (openRow?.id) {
      await supabase.from("payment_method_verifications").update({
        attempts: priorAttempts + 1,
        status: "verified",
        verified_at: new Date().toISOString(),
        failure_reason: null,
      }).eq("id", openRow.id);
    }

    await supabase
      .from("external_payment_recipients")
      .update({
        onboarding_status: complete ? "ready" : "awaiting_bank",
        provider_bank_name: refreshed?.bankName ?? recipient.provider_bank_name,
        provider_last_four: refreshed?.lastFourAccountNumber ?? recipient.provider_last_four,
      })
      .eq("id", recipient.id);

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.bank_account.micro_deposit.verified",
      new_status: "verified",
      environment,
      provider_metadata: { recipient_id: recipient.id, source: "recipient_link" },
    }));

    return json({
      success: true,
      already_verified: false,
      bank_status: String(refreshed?.status ?? "verified").toLowerCase(),
      complete,
      account_id: accountId,
      environment,
    });
  } catch (e) {
    console.error("[moov-recipient-bank-verify]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
