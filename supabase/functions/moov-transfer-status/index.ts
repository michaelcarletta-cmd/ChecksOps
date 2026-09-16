import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  facilitatorAccountId,
  moovFetch,
  normalizeTransferStatus,
  scopes,
} from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";
import { postTransferLedger } from "../_shared/moovWallet.ts";

/**
 * Re-reads the live status of a tenant's in-flight transfers from Moov and
 * writes the provider's answer back to `payment_transfers`.
 *
 * Webhooks are the primary path; this exists so a user can ask "did it work?"
 * and get the provider's current truth on demand. Nothing is inferred locally.
 */

const IN_FLIGHT = ["pending", "processing", "submitted", "queued", "created"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenantId: string | null = body?.tenant_id ?? null;
    if (!tenantId) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenantId);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: rows, error } = await supabase
      .from("payment_transfers")
      .select("id, tenant_id, provider_transfer_id, status, amount_cents, description, wallet_id, leg_role, transfer_group_id, claim_id, check_id")
      .eq("tenant_id", tenantId)
      .in("status", IN_FLIGHT)
      .not("provider_transfer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    if (!rows?.length) {
      return json({ success: true, checked: 0, updated: 0, results: [] });
    }

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    let platformAccount: string | null = null;
    try {
      platformAccount = await facilitatorAccountId(account?.provider_account_id ?? undefined);
    } catch (e) {
      console.error("[moov-transfer-status] facilitator", (e as Error).message);
      return json({
        success: false,
        error: "Couldn't reach the bank to check transfer status. Try Refresh balances, then check again.",
        checked: 0,
        updated: 0,
        results: [],
      });
    }

    const results: Record<string, unknown>[] = [];
    let updated = 0;

    for (const row of rows) {
      try {
        const remote = await moovFetch<any>(
          `/accounts/${platformAccount}/transfers/${row.provider_transfer_id}`,
          { scopes: scopes.transfersRead(platformAccount) },
        );

        const status = normalizeTransferStatus(remote?.status);
        const terminal = ["completed", "failed", "canceled", "returned"].includes(status);

        if (status !== row.status) {
          await supabase
            .from("payment_transfers")
            .update({
              status,
              completed_at: status === "completed" ? new Date().toISOString() : null,
            })
            .eq("id", row.id);
          updated++;

          // Keep the local ledger in step with the provider's answer, so a
          // missed webhook never leaves the balance history with a hole.
          await postTransferLedger(supabase, row as any, status, row.provider_transfer_id);

          await logPaymentEvent(supabase, {
            tenant_id: tenantId,
            provider_transfer_id: row.provider_transfer_id,
            event_type: "transfer.status_refresh",
            previous_status: row.status,
            new_status: status,
            environment,
            provider_metadata: sanitize({ moov_status: remote?.status ?? null }),
          });
        }

        results.push({
          id: row.id,
          provider_transfer_id: row.provider_transfer_id,
          status,
          moov_status: remote?.status ?? null,
          terminal,
          amount_cents: row.amount_cents,
          description: row.description,
        });
      } catch (e) {
        results.push({
          id: row.id,
          provider_transfer_id: row.provider_transfer_id,
          status: row.status,
          error: (e as Error).message,
        });
      }
    }

    return json({ success: true, checked: rows.length, updated, results });
  } catch (e) {
    console.error("[moov-transfer-status]", (e as Error).message);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
