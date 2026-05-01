// Reports recorded check_billing_events to Stripe as meter events.
// Designed to be invoked on a cron schedule (every 5 min) and also manually by admins.
// Idempotent: each event is only reported once (status flips recorded -> reported).
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1) Get config
  const { data: cfg } = await admin
    .from("check_billing_config")
    .select("stripe_meter_event_name")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const meterEventName = cfg?.stripe_meter_event_name ?? "checks_processed";

  // 2) Pull a batch of recorded events
  const BATCH = 200;
  const { data: events, error: fetchErr } = await admin
    .from("check_billing_events")
    .select("id, tenant_id, billed_at, unit_price_cents")
    .eq("status", "recorded")
    .order("billed_at", { ascending: true })
    .limit(BATCH);

  if (fetchErr) {
    console.error("fetch events error", fetchErr);
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!events?.length) {
    return new Response(JSON.stringify({ processed: 0, message: "no events to report" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3) Get stripe customer ids per tenant
  const tenantIds = [...new Set(events.map((e) => e.tenant_id))];
  const { data: balances } = await admin
    .from("tenant_credit_balances")
    .select("tenant_id, stripe_customer_id")
    .in("tenant_id", tenantIds);

  const customerByTenant = new Map<string, string>();
  for (const b of balances ?? []) {
    if (b.stripe_customer_id) customerByTenant.set(b.tenant_id, b.stripe_customer_id);
  }

  let succeeded = 0;
  let skippedNoCustomer = 0;
  let failed = 0;

  for (const ev of events) {
    const customerId = customerByTenant.get(ev.tenant_id);
    if (!customerId) {
      skippedNoCustomer++;
      await admin
        .from("check_billing_events")
        .update({ status: "failed", error_message: "no stripe_customer_id for tenant" })
        .eq("id", ev.id);
      continue;
    }

    try {
      const meterEvent = await stripe.billing.meterEvents.create({
        event_name: meterEventName,
        identifier: ev.id, // dedup at Stripe — sending same id twice is a no-op
        timestamp: Math.floor(new Date(ev.billed_at).getTime() / 1000),
        payload: {
          stripe_customer_id: customerId,
          value: "1",
        },
      });

      await admin
        .from("check_billing_events")
        .update({
          status: "reported",
          stripe_customer_id: customerId,
          stripe_meter_event_id: meterEvent.identifier,
          reported_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", ev.id);

      succeeded++;
    } catch (e) {
      failed++;
      console.error("meter event error", ev.id, (e as Error).message);
      await admin
        .from("check_billing_events")
        .update({ status: "failed", error_message: (e as Error).message })
        .eq("id", ev.id);
    }
  }

  return new Response(
    JSON.stringify({
      processed: events.length,
      succeeded,
      failed,
      skipped_no_customer: skippedNoCustomer,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
