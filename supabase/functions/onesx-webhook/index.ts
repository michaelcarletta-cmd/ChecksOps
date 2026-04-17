// Public webhook for 1ESX. Validates a shared secret (passed as ?secret=...) before processing.
// 1ESX is expected to POST the order_id (and optionally status / files) when an order completes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ status: "error", message: "Method not allowed" }, 405);

  try {
    const expectedSecret = Deno.env.get("ONESX_WEBHOOK_SECRET");
    if (!expectedSecret) return json({ status: "error", message: "Webhook not configured" }, 500);

    // Accept secret either via query param or X-Webhook-Secret header
    const url = new URL(req.url);
    const querySecret = url.searchParams.get("secret");
    const headerSecret = req.headers.get("x-webhook-secret");
    const provided = querySecret ?? headerSecret;
    if (provided !== expectedSecret) {
      console.warn("[onesx-webhook] secret mismatch");
      return json({ status: "error", message: "Forbidden" }, 403);
    }

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return json({ status: "error", message: "Invalid JSON" }, 400);
    }

    // Try multiple common shapes 1ESX might send
    const orderId =
      (payload as any).order_id ??
      (payload as any).data?.order_id ??
      (payload as any).orderId ??
      null;

    if (!orderId) {
      console.warn("[onesx-webhook] no order_id in payload", payload);
      return json({ status: "error", message: "Missing order_id" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: order, error: lookupErr } = await admin
      .from("onesx_orders")
      .select("id, claim_id, status")
      .eq("onesx_order_id", orderId)
      .maybeSingle();

    if (lookupErr) {
      console.error("[onesx-webhook] lookup error", lookupErr);
      return json({ status: "error", message: "DB lookup failed" }, 500);
    }
    if (!order) {
      console.warn("[onesx-webhook] order not found locally", orderId);
      // Still return success so 1ESX doesn't keep retrying for an unknown order
      return json({ status: "success", message: "Order not tracked locally; ignored." });
    }

    const newStatus =
      (payload as any).status ??
      (payload as any).data?.status ??
      "completed";

    const files =
      (payload as any).files ??
      (payload as any).data?.files ??
      [];

    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      callback_payload: payload,
      report_files: Array.isArray(files) ? files : [],
      last_status_at: new Date().toISOString(),
    };
    if (newStatus === "completed") {
      updatePayload.completed_at = new Date().toISOString();
    }

    const { error: updateErr } = await admin
      .from("onesx_orders")
      .update(updatePayload)
      .eq("id", order.id);

    if (updateErr) {
      console.error("[onesx-webhook] update error", updateErr);
      return json({ status: "error", message: "DB update failed" }, 500);
    }

    return json({ status: "success", message: "Data logged." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[onesx-webhook]", msg);
    return json({ status: "error", message: msg }, 500);
  }
});
