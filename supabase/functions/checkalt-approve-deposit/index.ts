// Resolves a deposit parked in manual review (status 40 / pending_approval) by
// calling FinCapture's `/fincapture/deposit/approve` endpoint.
//
// Per CheckAlt production behavior (confirmed 2026-07-17):
//   action = 1 -> approval
//   action = 2 -> rejection (optional rejectCode/rejectNotes)
//   no rejectCode supplied -> defaults server-side to reject reason 1721 ("Rejected Through API")
//
// Valid payload fields: fiKey, referenceNumber (int64), action, approvedAmount,
// checkAccountNumber, rejectCode, rejectNotes. ssoKey and depositAccountNumber
// are NOT part of this schema.
//
// Response shape (FinCaptureAPIDepositApprovalResponse) is
// { success: boolean, status: string, statusDescription: string } — e.g.
// { "success": true, "status": "Approved", "statusDescription": "..." }.
// `status` is a human-readable word here, NOT a numeric code like the
// deposit/item and deposit/process endpoints use — it must not be run
// through Number(). A 200 HTTP response only means CheckAlt accepted the
// request; `success` reflects whether the approval/rejection actually took
// effect on their side, so it must be checked before we mark the deposit
// resolved.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
} from "../_shared/checkalt.ts";

const BodySchema = z.object({
  deposit_id: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
  approved_amount: z.number().positive().optional(),
  micr_account_number: z.string().optional(),
  reject_code: z.number().int().optional(),
  reject_notes: z.string().max(1000).optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
    const userId = user?.id;
    if (userErr || !userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { deposit_id, action, approved_amount, micr_account_number, reject_code, reject_notes } = parsed.data;

    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Only admins can approve or reject deposits" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: deposit, error: depErr } = await supabase
      .from("checkalt_deposits")
      .select("id, tenant_id, checkalt_reference, status, check_intake_item_id")
      .eq("id", deposit_id)
      .maybeSingle();
    if (depErr || !deposit) throw new Error(depErr?.message || "Deposit not found");
    if (!deposit.checkalt_reference) {
      throw new Error("Deposit has no CheckAlt reference yet — cannot approve/reject");
    }
    // Rejections may also be used to cancel/void a deposit that was already
    // auto-approved by the provider (e.g. an accidental duplicate submission),
    // as long as it has not cleared or already been returned/rejected.
    const cancellable = action === "reject" &&
      ["submitted", "pending", "processing"].includes(deposit.status ?? "");
    if (deposit.status !== "pending_approval" && !cancellable) {
      return new Response(JSON.stringify({
        error: `Deposit is in '${deposit.status}' status, not pending_approval`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    const cfg = await loadConfig(supabase);
    const fiKey = cfg.fi_key;

    const payload: Record<string, unknown> = {
      fiKey,
      referenceNumber: Number(deposit.checkalt_reference),
      action: action === "approve" ? 1 : 2,
    };
    if (action === "approve") {
      if (approved_amount !== undefined) payload.approvedAmount = approved_amount;
      if (micr_account_number) payload.checkAccountNumber = micr_account_number;
    } else {
      payload.rejectCode = reject_code ?? 1721;
      if (reject_notes) payload.rejectNotes = reject_notes;
    }

    const resp = await checkAltFetch(supabase, "/fincapture/deposit/approve", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const respJson = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: "CheckAlt approval call failed",
        status: resp.status,
        details: respJson,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // CheckAlt can return HTTP 200 while still declining the request (e.g. a
    // business-rule failure) — `success` is the real signal, not resp.ok.
    if (respJson?.success !== true) {
      return new Response(JSON.stringify({
        error: "CheckAlt did not confirm the approval",
        status: respJson?.status ?? null,
        status_description: respJson?.statusDescription ?? null,
        details: respJson,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // CheckAlt sometimes returns a numeric `status` (e.g. 120) with the real
    // human-readable outcome in `statusDescription` (e.g. "Rejected"). Inspect
    // both so a duplicate/blocked deposit doesn't get mislabeled as submitted.
    const apiStatusText = (
      String(respJson?.status ?? "") + " " + String(respJson?.statusDescription ?? "")
    ).toLowerCase();
    let internalStatus = action === "approve" ? "submitted" : "rejected";
    if (apiStatusText.includes("reject")) internalStatus = "rejected";
    else if (apiStatusText.includes("approv") || apiStatusText.includes("submit")) internalStatus = "submitted";

    const updates: Record<string, unknown> = {
      status: internalStatus,
      last_status_payload: respJson,
      approved_by: userId,
      approved_at: new Date().toISOString(),
    };
    if (internalStatus === "rejected") {
      updates.returned_at = new Date().toISOString();
      updates.reject_code = action === "reject" ? (reject_code ?? 1721) : null;
      updates.reject_notes = reject_notes ?? null;
    }

    const { error: updateErr } = await supabase
      .from("checkalt_deposits")
      .update(updates)
      .eq("id", deposit.id);
    if (updateErr) throw updateErr;

    // When cancelling a duplicate, another deposit for the same check may still
    // be live — in that case leave the check's own status alone.
    let siblingActive = false;
    if (deposit.check_intake_item_id && internalStatus === "rejected") {
      const { data: siblings } = await supabase
        .from("checkalt_deposits")
        .select("id, status")
        .eq("check_intake_item_id", deposit.check_intake_item_id)
        .neq("id", deposit.id);
      siblingActive = (siblings ?? []).some((s) =>
        ["submitted", "pending", "processing", "cleared", "pending_approval"].includes(s.status ?? "")
      );
    }

    if (deposit.check_intake_item_id && !siblingActive) {
      const approvedAtIso = String(updates.approved_at);
      const isApproved = internalStatus === "submitted";


      const { data: intake } = await supabase
        .from("check_intake_items")
        .select("tenant_id")
        .eq("id", deposit.check_intake_item_id)
        .maybeSingle();

      const { error: intakeUpdateErr } = await supabase
        .from("check_intake_items")
        .update(isApproved
          ? {
            check_stage: "deposited",
            status: "deposited",
            deposit_recommendation: null,
            deposited_at: approvedAtIso,
            deposited_by_tenant_id: intake?.tenant_id ?? null,
            updated_at: approvedAtIso,
          }
          : {
            check_stage: "ready_for_deposit",
            status: "approved_for_deposit",
            deposit_recommendation: "ready_for_deposit",
            deposited_at: null,
            updated_at: approvedAtIso,
          })
        .eq("id", deposit.check_intake_item_id);
      if (intakeUpdateErr) throw intakeUpdateErr;

      const { error: claimUpdateErr } = await supabase
        .from("claim_checks")
        .update({
          deposit_status: isApproved ? "deposited" : "returned",
        })
        .eq("check_intake_item_id", deposit.check_intake_item_id);
      if (claimUpdateErr) throw claimUpdateErr;

      const { data: depositItem } = await supabase
        .from("deposit_items")
        .select("id, provider")
        .eq("check_id", deposit.check_intake_item_id)
        .maybeSingle();
      if (depositItem && depositItem.provider === "checkalt") {
        if (isApproved) {
          await supabase
            .from("deposit_items")
            .update({
              status: "succeeded",
              cleared_at: approvedAtIso,
              provider_reference: deposit.checkalt_reference,
              provider_response: respJson,
              updated_at: approvedAtIso,
            })
            .eq("id", depositItem.id);
        } else if (internalStatus === "rejected") {
          await supabase
            .from("deposit_items")
            .update({
              status: "failed",
              exception_reason: respJson?.statusDescription ?? internalStatus,
              exception_code: String(respJson?.status ?? internalStatus),
              provider_response: respJson,
              updated_at: new Date().toISOString(),
            })
            .eq("id", depositItem.id);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      deposit_id: deposit.id,
      status: internalStatus,
      api_status: respJson?.status ?? null,
      status_description: respJson?.statusDescription ?? null,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-approve-deposit]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
