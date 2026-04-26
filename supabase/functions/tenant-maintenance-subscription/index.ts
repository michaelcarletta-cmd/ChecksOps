// Monthly maintenance fee subscription. Separate from credits.
// Caller passes `price_id` (Stripe price configured in your Stripe dashboard) OR `usd_per_month` to create one ad-hoc.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization");
    const { data: userData } = await supabaseClient.auth.getUser(authHeader.replace("Bearer ", ""));
    const user = userData.user;
    if (!user?.email) throw new Error("Not authenticated");

    const body = await req.json();
    const { tenant_id, action, price_id, usd_per_month } = body;
    if (!tenant_id) throw new Error("Missing tenant_id");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const { data: bal } = await supabaseClient
      .from("tenant_credit_balances")
      .select("stripe_customer_id, maintenance_subscription_id")
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    // Action: open billing portal to manage existing subscription
    if (action === "manage") {
      if (!bal?.stripe_customer_id) throw new Error("No billing account yet");
      const portal = await stripe.billingPortal.sessions.create({
        customer: bal.stripe_customer_id,
        return_url: `${req.headers.get("origin")}/settings?tab=white-label`,
      });
      return new Response(JSON.stringify({ url: portal.url }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: start subscription
    let customerId = bal?.stripe_customer_id ?? null;
    if (!customerId) {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      customerId = customers.data[0]?.id ?? (await stripe.customers.create({
        email: user.email,
        metadata: { tenant_id },
      })).id;
    }

    let lineItem: any;
    if (price_id) {
      lineItem = { price: price_id, quantity: 1 };
    } else if (usd_per_month && Number(usd_per_month) > 0) {
      // Create an ad-hoc recurring price (useful when admin sets a custom maintenance fee per tenant)
      const product = await stripe.products.create({
        name: `ChecksOps Maintenance — Tenant ${tenant_id.slice(0, 8)}`,
        metadata: { tenant_id, purpose: "maintenance_fee" },
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(Number(usd_per_month) * 100),
        currency: "usd",
        recurring: { interval: "month" },
      });
      lineItem = { price: price.id, quantity: 1 };
    } else {
      throw new Error("Provide either price_id or usd_per_month");
    }

    const origin = req.headers.get("origin") ?? "";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [lineItem],
      success_url: `${origin}/settings?tab=white-label&maintenance=success`,
      cancel_url: `${origin}/settings?tab=white-label&maintenance=cancelled`,
      metadata: { tenant_id, purpose: "maintenance_subscription" },
    });

    // Persist customer id immediately
    await supabaseClient
      .from("tenant_credit_balances")
      .update({ stripe_customer_id: customerId })
      .eq("tenant_id", tenant_id);

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("tenant-maintenance-subscription error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
