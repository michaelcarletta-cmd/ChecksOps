import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid, plaidEnv } from "../_shared/plaidClient.ts";

// Phase 2 of the Plaid migration: actually moves the money.
//
// Mirrors actum-disburse's contract exactly ({ batch_id } in, per-split results
// out) so the disbursement console and payroll dialog only have to swap the
// function name based on the tenant's rail. Nothing here touches Actum.
//
// Plaid Transfer is single-leg: ChecksOps' own Plaid ledger balance funds each
// credit, so there is no debit leg to decline (the DMR201/DMR206 class of
// failure disappears). A split is only marked submitted when Plaid returns a
// transfer — anything else is recorded as failed with the reason.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Maps the UI delivery speed onto a Plaid Transfer network. */
function networkFor(speed: string): string {
  if (speed === "instant") return "rtp";
  if (speed === "same_day") return "same-day-ach";
  return "ach"; // next_day / standard
}

/** PPD for consumers, CCD for businesses — same split as the Actum sub IDs. */
function achClassFor(accountType: string | null | undefined): string {
  return accountType === "insured" || accountType === "homeowner" ? "ppd" : "ccd";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { batch_id } = await req.json();
    if (!batch_id) return json({ error: "batch_id is required" }, 400);

    const { data: batch, error: batchErr } = await supabase
      .from("disbursement_batches")
      .select("*")
      .eq("id", batch_id)
      .single();
    if (batchErr || !batch) return json({ error: "Batch not found" }, 404);
    if (batch.status !== "pending") return json({ error: `Batch is already ${batch.status}` }, 400);

    // Caller must belong to the batch's tenant.
    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", batch.tenant_id)
      .maybeSingle();
    if (!membership) return json({ error: "Forbidden" }, 403);

    const { data: splits, error: splitsErr } = await supabase
      .from("disbursement_splits")
      .select(
        `*, stakeholder_accounts(id, custname, account_type, plaid_access_token, plaid_account_id, verification_status, verification_source)`,
      )
      .eq("batch_id", batch_id);
    if (splitsErr) return json({ error: splitsErr.message }, 400);
    if (!splits?.length) return json({ error: "Batch has no splits." }, 400);

    const deliverySpeed: string = batch.delivery_speed ?? "same_day";
    const network = networkFor(deliverySpeed);

    await supabase
      .from("disbursement_batches")
      .update({ rail: "plaid", submitted_at: new Date().toISOString(), debit_status: "not_applicable" })
      .eq("id", batch_id);

    const results: Array<{ split_id: string; status: string; transfer_id?: string; error?: string }> = [];

    for (const split of splits) {
      const acct = (split as any).stakeholder_accounts;
      const amount = Number(split.amount);

      const fail = async (message: string) => {
        await supabase
          .from("disbursement_splits")
          .update({
            rail: "plaid",
            status: "failed",
            return_desc: message.slice(0, 300),
            plaid_failure_reason: message.slice(0, 300),
          })
          .eq("id", split.id);
        results.push({ split_id: split.id, status: "failed", error: message });
        console.error(`[plaid-disburse] split ${split.id} failed: ${message}`);
      };

      if (!acct) {
        await fail("Split has no stakeholder account.");
        continue;
      }
      if (!(amount > 0)) {
        await fail("Split amount must be greater than zero.");
        continue;
      }
      if (!acct.plaid_access_token || !acct.plaid_account_id) {
        await fail(
          `${acct.custname ?? "This recipient"} has no linked Plaid bank account — send them a bank link first.`,
        );
        continue;
      }
      if (acct.verification_status !== "verified" && acct.verification_status !== "admin_override") {
        await fail(`${acct.custname ?? "This recipient"}'s bank account is not verified.`);
        continue;
      }

      const idempotencyKey = (split.idempotence_key ?? `plaid_${split.id}`).slice(0, 50);

      try {
        const authorization = await callPlaid<any>("/transfer/authorization/create", {
          access_token: acct.plaid_access_token,
          account_id: acct.plaid_account_id,
          type: "credit",
          network,
          amount: amount.toFixed(2),
          ach_class: achClassFor(acct.account_type),
          user: { legal_name: acct.custname ?? split.recipient_name ?? "Recipient" },
          idempotency_key: idempotencyKey,
        });

        const decision = authorization?.authorization?.decision;
        if (decision === "declined") {
          const rationale = authorization?.authorization?.decision_rationale;
          await fail(
            `Plaid declined the payout${rationale?.code ? ` [${rationale.code}]` : ""}: ${
              rationale?.description ?? "no reason provided"
            }`,
          );
          continue;
        }

        const transferRes = await callPlaid<any>("/transfer/create", {
          access_token: acct.plaid_access_token,
          account_id: acct.plaid_account_id,
          authorization_id: authorization?.authorization?.id,
          description: "ChecksOps".slice(0, 15),
        });

        const transfer = transferRes?.transfer;
        if (!transfer?.id) {
          await fail("Plaid did not return a transfer for this payout.");
          continue;
        }

        await supabase
          .from("disbursement_splits")
          .update({
            rail: "plaid",
            status: "submitted",
            submitted_at: new Date().toISOString(),
            plaid_authorization_id: authorization?.authorization?.id ?? null,
            plaid_transfer_id: transfer.id,
            plaid_transfer_status: transfer.status ?? "pending",
            plaid_failure_reason: null,
            return_desc: null,
          })
          .eq("id", split.id);

        await supabase.from("plaid_transfer_events").insert({
          tenant_id: batch.tenant_id,
          split_id: split.id,
          plaid_transfer_id: transfer.id,
          event_type: "transfer_created",
          transfer_status: transfer.status ?? "pending",
          amount,
          raw_payload: { network, env: plaidEnv(), transfer },
        });

        results.push({ split_id: split.id, status: "submitted", transfer_id: transfer.id });
        console.log(`[plaid-disburse] split ${split.id} -> transfer ${transfer.id} (${network})`);
      } catch (err: any) {
        await fail(err?.message ?? "Plaid transfer failed");
      }
    }

    const allSucceeded = results.every((r) => r.status === "submitted");
    const anySucceeded = results.some((r) => r.status === "submitted");

    await supabase
      .from("disbursement_batches")
      .update({
        status: allSucceeded ? "completed" : anySucceeded ? "partial" : "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", batch_id);

    if (!anySucceeded) {
      return json(
        {
          success: false,
          error: results[0]?.error ?? "Every payout in this batch failed.",
          results,
        },
        400,
      );
    }

    return json({ success: true, rail: "plaid", delivery_speed: deliverySpeed, network, results });
  } catch (err: any) {
    console.error("[plaid-disburse]", err);
    return json({ success: false, error: err.message }, 400);
  }
});
