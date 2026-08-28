import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { facilitatorAccountId, moovFetch, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
} from "../_shared/moovGuard.ts";
import { callerCanMoveFunds, isTerminalFundingStatus } from "../_shared/walletFunding.ts";

/**
 * Cancels a wallet funding request.
 *
 * A bank debit that is already processing CANNOT be truthfully cancelled, so
 * the request is left in place and flagged for attention instead of being
 * marked cancelled. We never tell a tenant money stopped when it did not.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, funding_request_id } = (await req.json().catch(() => ({}))) ?? {};
    if (!tenant_id || !funding_request_id) {
      return json({ error: "tenant_id and funding_request_id are required" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    if (!(await callerCanMoveFunds(supabase, userId, tenant_id))) {
      return json({ error: "You do not have permission to move funds." }, 403);
    }

    const { data: request } = await supabase
      .from("wallet_funding_requests").select("*")
      .eq("id", funding_request_id).eq("tenant_id", tenant_id).maybeSingle();
    if (!request) return json({ error: "Funding request not found." }, 404);

    if (isTerminalFundingStatus(request.status)) {
      return json({ success: true, already_final: true, status: request.status });
    }

    // Ask the provider for the live state before claiming anything.
    let providerStatus: string | null = null;
    if (request.moov_transfer_id && request.moov_account_id) {
      try {
        const facilitatorId = await facilitatorAccountId(request.moov_account_id);
        const live = await moovFetch<any>(
          `/accounts/${facilitatorId}/transfers/${request.moov_transfer_id}`,
          { scopes: scopes.transfersRead(facilitatorId) },
        );
        providerStatus = live?.status ?? null;
      } catch {
        providerStatus = null;
      }
    }

    const inFlight = providerStatus && !["canceled", "cancelled", "failed"].includes(providerStatus);

    if (inFlight) {
      // The debit is live. Stop the outgoing payment, keep the debit honest.
      if (request.related_payment_id) {
        await supabase.from("disbursement_batches").update({
          auto_send_after_funding: false,
          funding_status: "action_required",
        }).eq("id", request.related_payment_id);
      }
      await supabase.from("wallet_funding_requests").update({
        status: "action_required",
        failure_code: "cancel_not_possible",
        failure_reason: "The bank transfer is already processing and cannot be cancelled.",
      }).eq("id", funding_request_id);

      return json({
        success: false,
        code: "cancel_not_possible",
        message:
          "The bank transfer is already processing. The outgoing payment has been held, but the incoming funds will still arrive.",
        provider_status: providerStatus,
      });
    }

    const { data: updated } = await supabase
      .from("wallet_funding_requests")
      .update({ status: "canceled", failure_code: "canceled_by_user" })
      .eq("id", funding_request_id)
      .not("status", "in", "(completed,failed,returned,canceled)")
      .select().maybeSingle();

    if (request.related_payment_id) {
      await supabase.from("disbursement_batches").update({
        funding_status: "canceled",
        amount_reserved_cents: 0,
        auto_send_after_funding: false,
      }).eq("id", request.related_payment_id);
    }
    if (request.transfer_id) {
      await supabase.from("payment_transfers")
        .update({ status: "canceled" }).eq("id", request.transfer_id);
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "wallet.funding.canceled",
      environment,
      provider_metadata: { funding_request_id, payment_id: request.related_payment_id },
    });

    return json({ success: true, funding_request: updated ?? null });
  } catch (e) {
    console.error("[cancel-wallet-funding]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
