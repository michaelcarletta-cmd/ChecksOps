// Creates a 1ESX roof report order for a claim. Admins only.
// Stores the resulting order in `onesx_orders`. The webhook will later mark it complete.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { onesxFetch } from "../_shared/onesx.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    // Validate caller
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "Admin access required" }, 403);

    // Parse + validate input
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") return json({ error: "Invalid JSON" }, 400);

    const {
      claim_id,
      report_types,
      address,
      latitude,
      longitude,
      number_of_facets,
      primary_pitch,
      secondary_pitch,
      expedited_delivery,
      notes,
      meta_data,
    } = payload as Record<string, any>;

    if (!claim_id || typeof claim_id !== "string") {
      return json({ error: "claim_id is required" }, 400);
    }
    if (!Array.isArray(report_types) || report_types.length === 0) {
      return json({ error: "report_types must be a non-empty array" }, 400);
    }
    if (!address) return json({ error: "address is required" }, 400);
    if (latitude == null || longitude == null) {
      return json({ error: "latitude and longitude are required" }, 400);
    }

    // Lookup claim for name_or_claim
    const { data: claim, error: claimErr } = await admin
      .from("claims")
      .select("id, claim_number, policyholder_name")
      .eq("id", claim_id)
      .single();
    if (claimErr || !claim) return json({ error: "Claim not found" }, 404);

    // Build webhook URL with secret
    const webhookSecret = Deno.env.get("ONESX_WEBHOOK_SECRET");
    const callbackUrl = webhookSecret
      ? `${SUPABASE_URL}/functions/v1/onesx-webhook?secret=${encodeURIComponent(webhookSecret)}`
      : undefined;

    // Insert pending order locally first so we have a row to update
    const { data: localOrder, error: insertErr } = await admin
      .from("onesx_orders")
      .insert({
        claim_id,
        status: "submitting",
        report_types,
        address,
        latitude,
        longitude,
        number_of_facets: number_of_facets ?? null,
        primary_pitch: primary_pitch ?? null,
        secondary_pitch: secondary_pitch ?? null,
        expedited_delivery: !!expedited_delivery,
        notes: notes ?? null,
        meta_data: meta_data ?? {},
        created_by: userData.user.id,
      })
      .select()
      .single();
    if (insertErr || !localOrder) {
      return json({ error: `Could not create local order: ${insertErr?.message}` }, 500);
    }

    // Build 1ESX request payload
    const onesxPayload: Record<string, unknown> = {
      report_types,
      name_or_claim: claim.claim_number ?? claim.policyholder_name ?? `Claim ${claim_id.slice(0, 8)}`,
      meta_data: {
        ...(meta_data ?? {}),
        local_order_id: localOrder.id,
        claim_id,
      },
      latitude: String(latitude),
      longitude: String(longitude),
      selAddress: address,
      number_of_facets: number_of_facets != null ? String(number_of_facets) : undefined,
      primary_pitch: primary_pitch ?? undefined,
      secondary_pitch: secondary_pitch ?? undefined,
      expedited_delivery: !!expedited_delivery,
      notes: notes ?? "",
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    };

    // Persist request payload
    await admin
      .from("onesx_orders")
      .update({ request_payload: onesxPayload })
      .eq("id", localOrder.id);

    // Call 1ESX
    let onesxResp: { status: number; body: any };
    try {
      onesxResp = await onesxFetch("/order", {
        method: "POST",
        body: JSON.stringify(onesxPayload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "1ESX network error";
      await admin
        .from("onesx_orders")
        .update({ status: "error", last_error: msg, last_status_at: new Date().toISOString() })
        .eq("id", localOrder.id);
      return json({ error: msg }, 502);
    }

    if (!onesxResp.body?.success) {
      const msg = onesxResp.body?.message ?? `1ESX returned ${onesxResp.status}`;
      await admin
        .from("onesx_orders")
        .update({
          status: "error",
          last_error: msg,
          response_payload: onesxResp.body ?? null,
          last_status_at: new Date().toISOString(),
        })
        .eq("id", localOrder.id);
      return json({ error: msg, details: onesxResp.body }, onesxResp.status || 502);
    }

    const data = onesxResp.body.data ?? {};
    await admin
      .from("onesx_orders")
      .update({
        onesx_order_id: data.order_id ?? null,
        status: data.status ?? "pending",
        total: data.total ?? null,
        payment_status: data.payment_status ?? null,
        payment_message: data.payment_message ?? null,
        response_payload: onesxResp.body,
        last_status_at: new Date().toISOString(),
      })
      .eq("id", localOrder.id);

    return json({ success: true, order_id: data.order_id, local_id: localOrder.id, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[onesx-create-order]", msg);
    return json({ error: msg }, 500);
  }
});
