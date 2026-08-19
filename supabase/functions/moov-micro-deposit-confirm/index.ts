import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { MoovError, moovFetch, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
} from "../_shared/moovGuard.ts";

/**
 * Confirms the 4-digit Moov Instant Micro-deposit verification code.
 *
 * The code is ALWAYS submitted to Moov (PUT /verify). There is no local
 * bypass — not in sandbox, not anywhere. In Moov test mode the documented
 * success code is 0001; it travels the same real provider path as any other
 * code. Attempts are counted and capped so a wrong guess cannot be brute
 * forced, and a rejected code is never retried automatically.
 */

/** Maps a provider failure into a safe, user-facing message. */
function mapProviderError(e: unknown): { code: string; message: string } {
  const err = e as MoovError;
  const raw = `${(err?.message ?? "")} ${JSON.stringify((err as any)?.details ?? "")}`.toLowerCase();

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
      message: "No open verification for this bank account. Restart verification.",
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
    const body = await req.json().catch(() => ({}));
    const { tenant_id, verification_id, code } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!verification_id) return json({ error: "verification_id is required" }, 400);
    if (!code || typeof code !== "string" || !/^\d{4}$/.test(code)) {
      return json({ error: "Enter the 4-digit verification code." }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    // Tenant scoping: the verification row must belong to the calling tenant.
    const { data: verification } = await supabase
      .from("payment_method_verifications")
      .select("*")
      .eq("id", verification_id)
      .eq("tenant_id", tenant_id)
      .eq("environment", environment)
      .maybeSingle();
    if (!verification) return json({ error: "Verification not found." }, 404);

    // Provider is the only authority on verification state.
    let providerStatus: string | null = null;
    try {
      const bank = await moovFetch<any>(
        `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}`,
        { scopes: scopes.bankAccountsRead(verification.provider_account_id) },
      );
      providerStatus = String(bank?.status ?? "").toLowerCase();
    } catch {
      /* fall through — the PUT below is still authoritative */
    }

    if (providerStatus === "verified") {
      await supabase
        .from("payment_method_verifications")
        .update({ status: "verified", verified_at: new Date().toISOString(), failure_reason: null })
        .eq("id", verification_id);
      if (verification.payment_method_id) {
        await supabase
          .from("payment_provider_methods")
          .update({ verification_status: "verified", connection_status: "connected" })
          .eq("id", verification.payment_method_id);
      }
      return json({ success: true, already_verified: true, environment });
    }

    if (verification.attempts >= verification.max_attempts) {
      await supabase.from("payment_method_verifications")
        .update({ status: "max_attempts_exceeded" }).eq("id", verification_id);
      return json({
        error: "max_attempts_exceeded",
        requires_restart: true,
        message: "Too many incorrect attempts. Restart verification to receive a new deposit code.",
      }, 409);
    }

    const attempts = verification.attempts + 1;

    try {
      // Moov expects the statement code in its "MV####" form; the UI collects
      // only the four digits. The code itself is never logged.
      const digits = String(code).replace(/\D/g, "").slice(0, 4);
      await moovFetch<any>(
        `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}/verify`,
        {
          method: "PUT",
          scopes: scopes.bankAccountsWrite(verification.provider_account_id),
          body: { code: `MV${digits}` },
        },
      );
    } catch (e) {
      const mapped = mapProviderError(e);
      const exhausted = attempts >= verification.max_attempts ||
        mapped.code === "max_attempts_exceeded" || mapped.code === "verification_expired";

      await supabase.from("payment_method_verifications").update({
        attempts,
        status: exhausted
          ? (mapped.code === "verification_expired" ? "failed" : "max_attempts_exceeded")
          : "pending",
        failure_reason: mapped.code,
      }).eq("id", verification_id);

      return json({
        error: exhausted ? mapped.code : "verification_failed",
        requires_restart: exhausted,
        message: exhausted
          ? mapped.message
          : `${mapped.message}`,
        attempts_remaining: Math.max(0, verification.max_attempts - attempts),
      }, 409);
    }

    const { data: updated } = await supabase
      .from("payment_method_verifications")
      .update({
        attempts,
        status: "verified",
        verified_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq("id", verification_id).select().single();

    // Re-read the provider so the cached row mirrors Moov, never overrides it.
    let confirmedStatus = "verified";
    try {
      const bank = await moovFetch<any>(
        `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}`,
        { scopes: scopes.bankAccountsRead(verification.provider_account_id) },
      );
      confirmedStatus = String(bank?.status ?? "verified").toLowerCase();
    } catch {
      /* keep optimistic value; the sync call below reconciles */
    }

    if (verification.payment_method_id) {
      await supabase
        .from("payment_provider_methods")
        .update({
          verification_status: confirmedStatus === "verified" ? "verified" : confirmedStatus,
          connection_status: confirmedStatus === "verified" ? "connected" : "pending",
        })
        .eq("id", verification.payment_method_id);
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: verification.external_recipient_id,
      event_type: "bank_account.micro_deposit.verified",
      previous_status: "pending",
      new_status: confirmedStatus,
      environment,
    });

    return json({
      success: true,
      verification: updated,
      provider_status: confirmedStatus,
      environment,
    });
  } catch (e) {
    console.error("[moov-micro-deposit-confirm]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
