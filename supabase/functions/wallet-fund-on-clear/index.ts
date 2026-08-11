// Fund-on-clear worker.
//
// When CheckAlt reports a deposit cleared, a database trigger queues a balance
// top-up in `wallet_funding_queue`, scheduled for the clear date plus a
// configurable cushion (the money is in the tenant's bank, but "posted" is not
// always "collected"). This worker pulls the due rows and debits the tenant's
// own bank account into their own balance.
//
// Two modes:
//   1. Cron / batch  — no body: processes every due, queued row.
//   2. "Pull now"    — { queue_id } from an authenticated tenant member:
//                      runs that row immediately, ignoring the cushion.

import { moovConfigured, moovEnvironment } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  moovGloballyEnabled,
  requireMoovCaller,
  serviceClient,
} from "../_shared/moovGuard.ts";
import { fundWalletFromBank } from "../_shared/moovWalletFunding.ts";

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;

interface QueueRow {
  id: string;
  tenant_id: string;
  fund_cents: number;
  wallet_type: string;
  attempts: number;
  checkalt_deposit_id: string | null;
  check_intake_item_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!moovGloballyEnabled() || !moovConfigured()) {
      return json({ success: true, skipped: true, reason: "provider_disabled", processed: 0 });
    }

    const body = await req.json().catch(() => ({}));
    const queueId: string | undefined = body?.queue_id;
    const supabase = serviceClient();
    const environment = moovEnvironment();

    let rows: QueueRow[] = [];

    if (queueId) {
      const { data: row } = await supabase
        .from("wallet_funding_queue")
        .select("id, tenant_id, fund_cents, wallet_type, attempts, checkalt_deposit_id, check_intake_item_id")
        .eq("id", queueId)
        .maybeSingle();
      if (!row) return json({ error: "Funding request not found." }, 404);

      // Manual pulls are user-initiated, so the caller must belong to the org.
      const caller = await requireMoovCaller(req, row.tenant_id);
      if (isResponse(caller)) return caller;
      rows = [row as QueueRow];
    } else {
      const { data, error } = await supabase
        .from("wallet_funding_queue")
        .select("id, tenant_id, fund_cents, wallet_type, attempts, checkalt_deposit_id, check_intake_item_id")
        .eq("status", "queued")
        .lte("scheduled_for", new Date().toISOString())
        .lt("attempts", MAX_ATTEMPTS)
        .order("scheduled_for", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) throw error;
      rows = (data ?? []) as QueueRow[];
    }

    let funded = 0, failed = 0, skipped = 0;
    const results: Record<string, unknown>[] = [];

    for (const row of rows) {
      // Claim the row so overlapping cron ticks can't double-pull.
      const { data: claimed } = await supabase
        .from("wallet_funding_queue")
        .update({ status: "processing", attempts: row.attempts + 1 })
        .eq("id", row.id)
        .in("status", ["queued", "failed"])
        .select("id")
        .maybeSingle();
      if (!claimed) { skipped++; continue; }

      if (!row.fund_cents || row.fund_cents <= 0) {
        await supabase.from("wallet_funding_queue")
          .update({ status: "skipped", last_error: "Nothing to fund after holdback." })
          .eq("id", row.id);
        skipped++;
        continue;
      }

      const { data: tenant } = await supabase
        .from("tenants").select("moov_allowlisted").eq("id", row.tenant_id).maybeSingle();
      if (!(tenant as any)?.moov_allowlisted) {
        await supabase.from("wallet_funding_queue")
          .update({ status: "skipped", last_error: "Organization is not enabled for this payment provider." })
          .eq("id", row.id);
        skipped++;
        continue;
      }

      const result = await fundWalletFromBank(supabase, {
        tenantId: row.tenant_id,
        amountCents: row.fund_cents,
        environment,
        walletType: (row.wallet_type === "trust" ? "trust" : "operating"),
        description: "Automatic balance top-up (deposit cleared)",
        idempotencyKey: `fund-on-clear:${row.id}`,
      }).catch((e) => ({ ok: false, retryable: true, error: (e as Error).message }));

      if (result.ok) {
        funded++;
        await supabase.from("wallet_funding_queue").update({
          status: "funded",
          funded_at: new Date().toISOString(),
          transfer_id: (result as any).transferId ?? null,
          last_error: null,
        }).eq("id", row.id);
      } else {
        failed++;
        const terminal = result.retryable === false || row.attempts + 1 >= MAX_ATTEMPTS;
        await supabase.from("wallet_funding_queue").update({
          status: terminal ? "failed" : "queued",
          last_error: result.error ?? "Funding failed",
        }).eq("id", row.id);
      }

      results.push({ queue_id: row.id, ok: result.ok, error: result.error ?? null });
    }

    return json({
      success: true,
      processed: rows.length,
      funded,
      failed,
      skipped,
      results,
    });
  } catch (e) {
    console.error("[wallet-fund-on-clear]", (e as Error).message);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
