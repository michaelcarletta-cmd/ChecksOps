import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const PRICE_MAP: Record<string, string> = {
  contractor: "price_1TP0zzH3VpVROLD1OV98hMwq",
  public_adjuster: "price_1TP100H3VpVROLD19aAFfrYj",
  attorney: "price_1TP101H3VpVROLD1egSMDPRf",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const { professionalId, professionalType } = await req.json();

    if (!professionalId || !professionalType) {
      throw new Error("professionalId and professionalType are required");
    }

    const priceId = PRICE_MAP[professionalType];
    if (!priceId) {
      throw new Error(`Invalid professional type: ${professionalType}`);
    }

    // Get professional details
    const { data: professional, error: proError } = await supabaseClient
      .from("referral_professionals")
      .select("*")
      .eq("id", professionalId)
      .single();

    if (proError || !professional) {
      throw new Error("Professional not found");
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Check if Stripe customer exists
    let customerId = professional.stripe_customer_id;
    if (!customerId && professional.email) {
      const customers = await stripe.customers.list({ email: professional.email, limit: 1 });
      if (customers.data.length > 0) {
        customerId = customers.data[0].id;
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId || undefined,
      customer_email: customerId ? undefined : professional.email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${req.headers.get("origin")}/settings?tab=referral&status=success`,
      cancel_url: `${req.headers.get("origin")}/settings?tab=referral&status=cancelled`,
      metadata: {
        professional_id: professionalId,
        professional_type: professionalType,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("referral-checkout error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
