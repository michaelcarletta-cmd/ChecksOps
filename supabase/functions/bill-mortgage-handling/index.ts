// Bills a completed mortgage_handling_request to the tenant.
// - Auth: only mortgage_agent / admin can invoke.
// - Primary rail: platform_fee_line_items (pulled end-of-month via Moov fee rollup).
//   Handling fee ($10 first check / $5 additional) + any shipping label cost are
//   recorded as separate unbilled line items.
// - Stripe invoice item is best-effort only when the tenant has a stripe_customer_id.
// - Idempotent: skips if already billed; uses request id as idempotency key.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "missing_authorization" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json(500, { error: "STRIPE_SECRET_KEY not configured" });

  // Identify caller
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json(401, { error: "invalid_token" });
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Authorize: mortgage_agent or admin only
  const { data: roles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roleNames = (roles ?? []).map((r: any) => r.role);
  const authorized = roleNames.includes("admin") || roleNames.includes("mortgage_agent");
  if (!authorized) return json(403, { error: "not_authorized" });

  let payload: { request_id?: string; flat_fee_cents?: number; charge_immediately?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const requestId = payload.request_id;
  if (!requestId || typeof requestId !== "string") {
    return json(400, { error: "request_id required" });
  }

  // Load request
  const { data: request, error: reqErr } = await admin
    .from("mortgage_handling_requests")
    .select("*, tenants:tenant_id(name)")
    .eq("id", requestId)
    .maybeSingle();

  if (reqErr) return json(500, { error: reqErr.message });
  if (!request) return json(404, { error: "request_not_found" });

  // Idempotency: already billed
  if (request.billed_at && request.billing_status === "billed") {
    return json(200, {
      ok: true,
      already_billed: true,
      stripe_invoice_item_id: request.stripe_invoice_item_id,
    });
  }

  // Resolve fee: $10 for first check, $5 for additional checks
  const { data: siblingCountRes } = await admin
    .from("mortgage_handling_requests")
    .select("id", { count: "exact" })
    .eq("claim_id", request.claim_id)
    .eq("billing_status", "billed");
  
  const isAdditional = (siblingCountRes?.length ?? 0) > 0;
  const defaultFee = isAdditional ? 500 : 1000;

  const feeCents =
    (typeof payload.flat_fee_cents === "number" && payload.flat_fee_cents > 0
      ? payload.flat_fee_cents
      : null) ??
    request.flat_fee_cents ??
    defaultFee;

  // Resolve tenant Stripe customer
  const { data: balance } = await admin
    .from("tenant_credit_balances")
    .select("stripe_customer_id")
    .eq("tenant_id", request.tenant_id)
    .maybeSingle();

  const customerId = balance?.stripe_customer_id ?? null;

  if (!customerId) {
    await admin
      .from("mortgage_handling_requests")
      .update({
        billing_status: "failed",
        billing_error: "no stripe_customer_id for tenant",
        flat_fee_cents: feeCents,
      })
      .eq("id", requestId);
    return json(422, { error: "no_stripe_customer_for_tenant", tenant_id: request.tenant_id });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

  const tenantName = (request as any).tenants?.name ?? request.tenant_id.slice(0, 8);
  const companyLabel = request.mortgage_company || request.mortgage_servicer || "mortgage company";
  const description = `Mortgage handling — ${companyLabel} (tenant ${tenantName})`;

  let invoiceItemId: string | null = null;
  let invoiceId: string | null = null;

  try {
    const invoiceItem = await stripe.invoiceItems.create(
      {
        customer: customerId,
        amount: feeCents,
        currency: "usd",
        description,
        metadata: {
          source: "mortgage_handling",
          request_id: requestId,
          tenant_id: request.tenant_id,
        },
      },
      { idempotencyKey: `mortgage_handling:${requestId}` },
    );
    invoiceItemId = invoiceItem.id;

    if (payload.charge_immediately) {
      const invoice = await stripe.invoices.create(
        {
          customer: customerId,
          collection_method: "charge_automatically",
          auto_advance: true,
          metadata: { source: "mortgage_handling", request_id: requestId },
        },
        { idempotencyKey: `mortgage_handling_inv:${requestId}` },
      );
      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
      invoiceId = finalized.id;
      try {
        await stripe.invoices.pay(finalized.id);
      } catch (payErr) {
        console.error("invoice pay failed", requestId, (payErr as Error).message);
      }
    }
  } catch (e) {
    const msg = (e as Error).message || "stripe_error";
    console.error("stripe error", requestId, msg);
    await admin
      .from("mortgage_handling_requests")
      .update({
        billing_status: "failed",
        billing_error: msg,
        flat_fee_cents: feeCents,
      })
      .eq("id", requestId);
    return json(502, { error: "stripe_error", details: msg });
  }

  const { error: updateErr } = await admin
    .from("mortgage_handling_requests")
    .update({
      billing_status: "billed",
      billed_at: new Date().toISOString(),
      flat_fee_cents: feeCents,
      stripe_invoice_item_id: invoiceItemId,
      stripe_invoice_id: invoiceId,
      billing_error: null,
    })
    .eq("id", requestId);

  if (updateErr) {
    console.error("post-billing update failed", requestId, updateErr.message);
  }

  return json(200, {
    ok: true,
    request_id: requestId,
    flat_fee_cents: feeCents,
    stripe_invoice_item_id: invoiceItemId,
    stripe_invoice_id: invoiceId,
    tenant_name: tenantName,
  });
});
