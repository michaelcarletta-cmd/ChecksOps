import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";

/**
 * Starts bank-account ownership verification for a recipient who will not use
 * an instant bank login. A $0.01 credit lands in the account containing a 
 * 4-digit verification code (MV####).
 *
 * Nothing here ever touches a full account or routing number: the bank account
 * is already stored at the provider and referenced only by its provider id.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, payment_method_id = null, external_recipient_id = null } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    // Callers that manage a specific recipient pass the method explicitly. The
    // organization's own settlement bank has exactly one connected method, so
    // fall back to it when no id is supplied.
    let methodQuery = supabase
      .from("payment_provider_methods")
      .select("*")
      .eq("provider", "moov")
      .eq("environment", environment);

    methodQuery = payment_method_id
      ? methodQuery.eq("id", payment_method_id)
      : methodQuery
          .eq("tenant_id", tenant_id)
          .is("external_recipient_id", null)
          .neq("connection_status", "disconnected")
          .order("created_at", { ascending: false })
          .limit(1);

    const { data: method } = await methodQuery.maybeSingle();
    if (!method) return json({ error: "Bank account not found." }, 404);


    // The bank account must belong to this tenant or to one of its recipients.
    if (method.tenant_id && method.tenant_id !== tenant_id) {
      return json({ error: "Forbidden" }, 403);
    }

    const accountId = method.provider_account_id;
    const bankAccountId = method.provider_bank_account_id;
    if (!accountId || !bankAccountId) {
      return json({ error: "This bank account is not ready for verification yet." }, 409);
    }

    // Guard against endless retries on the same account.
    const { data: prior } = await supabase
      .from("payment_method_verifications")
      .select("*")
      .eq("payment_method_id", payment_method_id)
      .eq("environment", environment)
      .order("created_at", { ascending: false })
      .maybeSingle();

    if (prior?.status === "verified") {
      return json({ success: true, already_verified: true, verification: prior });
    }
    if (prior && prior.attempts >= prior.max_attempts) {
      return json({
        error: "max_attempts_exceeded",
        message: "This bank account has failed verification too many times. Connect it again.",
      }, 409);
    }

    // Current API: POST .../verify (Instant Micro-deposit)
    // The v2024.01.00 version explicitly supports this endpoint with the 
    // expected 4-digit MV#### code generation.
    try {
      await moovFetch<any>(
        `/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`,
        { 
          method: "POST", 
          scopes: scopes.bankAccountsWrite(accountId),
        },
      );
    } catch (e) {
      console.error("[moov-micro-deposit-initiate] error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }

    const { data: verification, error: vErr } = await supabase
      .from("payment_method_verifications")
      .insert({
        tenant_id,
        payment_method_id,
        external_recipient_id,
        provider: "moov",
        environment,
        provider_account_id: accountId,
        provider_bank_account_id: bankAccountId,
        method: "micro_deposit",
        status: "pending",
        attempts: 0,
        initiated_by: userId,
      })
      .select().single();
    if (vErr) return json({ error: vErr.message }, 500);

    await supabase
      .from("payment_provider_methods")
      .update({ verification_status: "pending_micro_deposit" })
      .eq("id", payment_method_id);

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: external_recipient_id,
      event_type: "bank_account.micro_deposit.initiated",
      new_status: "pending",
      environment,
      provider_metadata: sanitize({ bank_account: bankAccountId }),
    });

    return json({ success: true, verification });
  } catch (e) {
    console.error("[moov-micro-deposit-initiate]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
