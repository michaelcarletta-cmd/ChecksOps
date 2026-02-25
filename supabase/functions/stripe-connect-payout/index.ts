import Stripe from "https://esm.sh/stripe@18.5.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-CONNECT-PAYOUT] ${step}${detailsStr}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    const { action, ...params } = await req.json();
    logStep("Action received", { action });

    // Create an Express connected account for a contractor/homeowner
    if (action === "create-connected-account") {
      const { email, name, type } = params; // type: 'contractor' | 'client' | 'referrer'
      logStep("Creating connected account", { email, name, type });

      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
        metadata: {
          recipient_type: type,
          recipient_name: name,
        },
      });

      logStep("Connected account created", { accountId: account.id });

      return new Response(JSON.stringify({ 
        success: true, 
        accountId: account.id 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create an account link for onboarding (they'll add their bank details)
    if (action === "create-account-link") {
      const { accountId, returnUrl } = params;
      logStep("Creating account link", { accountId });

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: returnUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });

      logStep("Account link created", { url: accountLink.url });

      return new Response(JSON.stringify({ 
        success: true, 
        url: accountLink.url 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check account status
    if (action === "get-account-status") {
      const { accountId } = params;
      logStep("Getting account status", { accountId });

      const account = await stripe.accounts.retrieve(accountId);
      
      return new Response(JSON.stringify({ 
        success: true,
        accountId: account.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        email: account.email,
        metadata: account.metadata,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create a transfer to a connected account (pay them)
    if (action === "create-transfer") {
      const { accountId, amount, description } = params;
      logStep("Creating transfer", { accountId, amount, description });

      // Amount is in cents
      const transfer = await stripe.transfers.create({
        amount: Math.round(amount * 100), // Convert dollars to cents
        currency: "usd",
        destination: accountId,
        description: description || "Payment from Freedom Claims",
      });

      logStep("Transfer created", { transferId: transfer.id, amount: transfer.amount });

      return new Response(JSON.stringify({ 
        success: true, 
        transferId: transfer.id,
        amount: transfer.amount / 100,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get platform balance
    if (action === "get-balance") {
      logStep("Getting platform balance");

      const balance = await stripe.balance.retrieve();
      
      const availableUSD = balance.available.find((b: { currency: string; amount: number }) => b.currency === 'usd');
      const pendingUSD = balance.pending.find((b: { currency: string; amount: number }) => b.currency === 'usd');

      return new Response(JSON.stringify({ 
        success: true,
        available: (availableUSD?.amount || 0) / 100,
        pending: (pendingUSD?.amount || 0) / 100,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // List transfers
    if (action === "list-transfers") {
      const { accountId, limit = 10 } = params;
      logStep("Listing transfers", { accountId, limit });

      const transfers = await stripe.transfers.list({
        destination: accountId,
        limit: limit,
      });

      return new Response(JSON.stringify({ 
        success: true,
        transfers: transfers.data.map((t: { id: string; amount: number; created: number; description: string | null }) => ({
          id: t.id,
          amount: t.amount / 100,
          created: new Date(t.created * 1000).toISOString(),
          description: t.description,
        })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Invalid action");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
