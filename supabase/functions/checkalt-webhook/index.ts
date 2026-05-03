// Public endpoint CheckAlt posts to when a deposit changes status.
// verify_jwt = false (configured in supabase/config.toml).
// Validates a shared secret header, logs every payload to checkalt_webhook_events,
// then updates checkalt_deposits + claim_checks accordingly.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { getServiceClient } from "../_shared/checkalt.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const supabase = getServiceClient();
  let raw: unknown = null;
  let signatureValid = false;

  try {
    raw = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- shared-secret check (CheckAlt sends a header we configure on registration) ---
  const expectedSecret = Deno.env.get("CHECKALT_WEBHOOK_SECRET");
  const providedSecret =
    req.headers.get("X-CheckAlt-Signature") ?? req.headers.get("X-Webhook-Secret") ?? "";
  signatureValid = !!expectedSecret && providedSecret === expectedSecret;

  // Always log the event (even invalid ones — useful for debugging registration)
  const payload = raw as Record<string, unknown>;
  const eventType =
    (payload?.eventType as string) ?? (payload?.type as string) ?? "unknown";
  const reference =
    (payload?.reference as string) ??
    (payload?.referenceId as string) ??
    (payload?.depositReference as string) ??
    null;

  const { data: eventRow } = await supabase
    .from("checkalt_webhook_events")
    .insert({
      event_type: eventType,
      checkalt_reference: reference,
      raw_payload: payload,
      signature_valid: signatureValid,
    })
    .select()
    .single();

  if (!signatureValid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- map FinCapture status -> internal status ---
  const rawStatus = String(payload?.status ?? "").toLowerCase();
  const statusMap: Record<string, string> = {
    submitted: "submitted",
    pending: "submitted",
    pending_approval: "pending_approval",
    approved: "cleared",
    cleared: "cleared",
    settled: "cleared",
    returned: "returned",
    rejected: "rejected",
    declined: "rejected",
  };
  const internalStatus = statusMap[rawStatus] ?? rawStatus;

  try {
    if (reference) {
      const updates: Record<string, unknown> = {
        status: internalStatus,
        last_status_payload: payload,
      };
      if (internalStatus === "cleared") updates.cleared_at = new Date().toISOString();
      if (internalStatus === "returned") {
        updates.returned_at = new Date().toISOString();
        updates.return_reason = payload?.returnReason ?? payload?.reason ?? null;
      }

      await supabase
        .from("checkalt_deposits")
        .update(updates)
        .eq("checkalt_reference", reference);

      // Mirror to claim_checks for downstream UI
      const { data: dep } = await supabase
        .from("checkalt_deposits")
        .select("id, check_intake_item_id")
        .eq("checkalt_reference", reference)
        .maybeSingle();
      if (dep?.check_intake_item_id) {
        const ccUpdates: Record<string, unknown> = {};
        if (internalStatus === "cleared") {
          ccUpdates.deposit_status = "cleared";
          ccUpdates.cleared_status = "cleared";
        } else if (internalStatus === "returned" || internalStatus === "rejected") {
          ccUpdates.deposit_status = "returned";
        } else if (internalStatus === "submitted" || internalStatus === "pending_approval") {
          ccUpdates.deposit_status = "deposited";
        }
        if (Object.keys(ccUpdates).length > 0) {
          await supabase
            .from("claim_checks")
            .update(ccUpdates)
            .eq("check_intake_item_id", dep.check_intake_item_id);
        }
      }
    }

    if (eventRow?.id) {
      await supabase
        .from("checkalt_webhook_events")
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq("id", eventRow.id);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (eventRow?.id) {
      await supabase
        .from("checkalt_webhook_events")
        .update({ processed: false, process_error: msg })
        .eq("id", eventRow.id);
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
