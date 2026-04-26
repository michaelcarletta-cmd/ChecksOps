// Pass-through credit top-up: client pays exact USD amount, gets (amount / usd_per_credit) credits.
// No markup. Stripe Checkout in payment mode (one-time, not subscription).
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_USD = 5;
const MAX_USD = 5000;

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
    const token = authHeader.replace("Bearer ", "");
    const { data: userData } = await supabaseClient.auth.getUser(token);
    const user = userData.user;
    if (!user?.email) throw new Error("Not authenticated");

    const body = await req.json();
    const tenant_id: string = body.tenant_id;
    const usd_amount: number = Number(body.usd_amount);

    if (!tenant_id) throw new Error("Missing tenant_id");
    if (!Number.isFinite(usd_amount) || usd_amount < MIN_USD || usd_amount > MAX_USD) {
      throw new Error(`Top-up must be between $${MIN_USD} and $${MAX_USD}`);
    }

    // Read current pass-through rate for this tenant
    const { data: bal, error: balErr } = await supabaseClient
      .from("tenant_credit_balances")
      .select("usd_per_credit, stripe_customer_id")
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (balErr) throw balErr;

    const usdPerCredit = Number(bal?.usd_per_credit ?? 0.015);
    const credits = Math.floor(usd_amount / usdPerCredit);

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Find or create Stripe customer
    let customerId = bal?.stripe_customer_id ?? null;
    if (!customerId) {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      customerId = customers.data[0]?.id ?? (await stripe.customers.create({
        email: user.email,
        metadata: { tenant_id },
      })).id;
      await supabaseClient
        .from("tenant_credit_balances")
        .update({ stripe_customer_id: customerId })
        .eq("tenant_id", tenant_id);
    }

    const origin = req.headers.get("origin") ?? "";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `${credits.toLocaleString()} AI processing credits`,
            description: `Pass-through cost top-up at $${usdPerCredit.toFixed(4)}/credit. No markup.`,
          },
          unit_amount: Math.round(usd_amount * 100), // cents
        },
        quantity: 1,
      }],
      success_url: `${origin}/settings?tab=white-label&topup=success`,
      cancel_url: `${origin}/settings?tab=white-label&topup=cancelled`,
      metadata: {
        tenant_id,
        credits: String(credits),
        usd_amount: String(usd_amount),
        usd_per_credit: String(usdPerCredit),
        purpose: "credit_topup",
      },
    });

    return new Response(JSON.stringify({ url: session.url, credits, usd_per_credit: usdPerCredit }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("tenant-credit-topup error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
