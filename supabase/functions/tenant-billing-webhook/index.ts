// Stripe webhook: completes credit top-ups and tracks maintenance subscription state.
// Configure in Stripe → Developers → Webhooks pointing at this function.
// Set STRIPE_WEBHOOK_SECRET in project secrets.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2025-08-27.basil",
  });
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = webhookSecret && sig
      ? await stripe.webhooks.constructEventAsync(raw, sig, webhookSecret)
      : (JSON.parse(raw) as Stripe.Event);
  } catch (e) {
    console.error("webhook signature error:", e);
    return new Response(`Webhook Error: ${(e as Error).message}`, { status: 400 });
  }

  // Use service role for trusted DB writes
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const purpose = session.metadata?.purpose;
      const tenant_id = session.metadata?.tenant_id;
      if (!tenant_id) return new Response("ok", { status: 200 });

      if (purpose === "credit_topup" && session.payment_status === "paid") {
        const credits = parseInt(session.metadata?.credits ?? "0", 10);
        const usd = Number(session.metadata?.usd_amount ?? "0");
        if (credits > 0) {
          const { data: cur } = await admin
            .from("tenant_credit_balances")
            .select("balance, lifetime_purchased")
            .eq("tenant_id", tenant_id)
            .maybeSingle();
          const newBalance = (cur?.balance ?? 0) + credits;
          await admin
            .from("tenant_credit_balances")
            .update({
              balance: newBalance,
              lifetime_purchased: (cur?.lifetime_purchased ?? 0) + credits,
              has_payment_method: true,
              updated_at: new Date().toISOString(),
            })
            .eq("tenant_id", tenant_id);
          await admin.from("tenant_credit_transactions").insert({
            tenant_id,
            transaction_type: "purchase",
            amount: credits,
            balance_after: newBalance,
            description: `Top-up: ${credits.toLocaleString()} credits for $${usd.toFixed(2)} (pass-through)`,
            reference_id: session.id,
            reference_type: "stripe_checkout",
          });
        }
      }

      if (purpose === "maintenance_subscription" && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await admin
          .from("tenant_credit_balances")
          .update({
            maintenance_subscription_id: sub.id,
            maintenance_subscription_status: sub.status,
            maintenance_price_id: sub.items.data[0]?.price.id ?? null,
            maintenance_current_period_end: new Date((sub as any).current_period_end * 1000).toISOString(),
            has_payment_method: true,
          })
          .eq("tenant_id", tenant_id);
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      await admin
        .from("tenant_credit_balances")
        .update({
          maintenance_subscription_status: sub.status,
          maintenance_current_period_end: new Date((sub as any).current_period_end * 1000).toISOString(),
        })
        .eq("maintenance_subscription_id", sub.id);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("webhook handler error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
