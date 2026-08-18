import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
} from "../_shared/moovGuard.ts";

/**
 * Confirms the 4-digit verification code and marks the bank account verified.
 * Attempts are counted and capped so a wrong guess cannot be brute forced.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, verification_id, code } = body ?? {};
    
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!verification_id) return json({ error: "verification_id is required" }, 400);
    if (!code || typeof code !== "string" || !/^\d{4}$/.test(code)) {
      return json({ error: "Enter the 4-digit verification code (e.g., 1234)." }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: verification } = await supabase
      .from("payment_method_verifications")
      .select("*")
      .eq("id", verification_id)
      .eq("tenant_id", tenant_id)
      .eq("environment", environment)
      .maybeSingle();
    if (!verification) return json({ error: "Verification not found." }, 404);
    if (verification.status === "verified") {
      return json({ success: true, already_verified: true, verification });
    }
    if (verification.attempts >= verification.max_attempts) {
      await supabase.from("payment_method_verifications")
        .update({ status: "max_attempts_exceeded" }).eq("id", verification_id);
      return json({
        error: "max_attempts_exceeded",
        message: "Too many incorrect attempts. Connect the bank account again.",
      }, 409);
    }

    const attempts = verification.attempts + 1;

    try {
      // Completion endpoint (Instant Micro-deposit)
      try {
        // Sandbox bypass for testing
        if (environment === "sandbox" && code === "0000") {
          console.log("[moov-micro-deposit-confirm] Sandbox override triggered");
        } else {
          await moovFetch<any>(
            `/accounts/${verification.provider_account_id}/bank-accounts/${verification.provider_bank_account_id}/verify`,
            {
              method: "PUT",
              scopes: scopes.bankAccountsWrite(verification.provider_account_id),
              body: { code },
            },
          );
        }
      } catch (inner) {
        throw inner;
      }
    } catch (e) {
      const exhausted = attempts >= verification.max_attempts;
      await supabase.from("payment_method_verifications").update({
        attempts,
        status: exhausted ? "max_attempts_exceeded" : "pending",
        failure_reason: (e as Error).message,
      }).eq("id", verification_id);

      return json({
        error: exhausted ? "max_attempts_exceeded" : "verification_failed",
        message: exhausted
          ? "Too many incorrect attempts. Connect the bank account again."
          : "That code did not match. Please check your statement and try again.",
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

    if (verification.payment_method_id) {
      await supabase
        .from("payment_provider_methods")
        .update({ verification_status: "verified", connection_status: "connected" })
        .eq("id", verification.payment_method_id);
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: verification.external_recipient_id,
      event_type: "bank_account.micro_deposit.verified",
      previous_status: "pending",
      new_status: "verified",
      environment,
    });

    return json({ success: true, verification: updated });
  } catch (e) {
    console.error("[moov-micro-deposit-confirm]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
