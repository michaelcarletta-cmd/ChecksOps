const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[COLLECT-PAYMENT] ${step}${detailsStr}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      amount,
      description,
      customerEmail,
      customerName,
      invoiceNumber,
      claimNumber,
      successUrl,
      cancelUrl,
    } = await req.json();

    if (!amount || amount <= 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Amount must be greater than 0" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logStep("Creating Ramp receivable link", { amount, customerEmail, invoiceNumber });

    const template =
      Deno.env.get("RAMP_RECEIVABLES_URL_TEMPLATE") ||
      Deno.env.get("RAMP_PAYMENT_LINK_TEMPLATE");

    if (!template) {
      throw new Error(
        "Ramp receivable links are not configured. Set RAMP_RECEIVABLES_URL_TEMPLATE or RAMP_PAYMENT_LINK_TEMPLATE."
      );
    }

    const replacements: Record<string, string> = {
      amount: Number(amount).toFixed(2),
      description: String(description || ""),
      customerEmail: String(customerEmail || ""),
      customerName: String(customerName || ""),
      invoiceNumber: String(invoiceNumber || ""),
      claimNumber: String(claimNumber || ""),
      successUrl: String(successUrl || ""),
      cancelUrl: String(cancelUrl || ""),
    };

    let url = template;
    let replacedAny = false;
    for (const [key, value] of Object.entries(replacements)) {
      const token = `{${key}}`;
      if (url.includes(token)) {
        replacedAny = true;
        url = url.split(token).join(encodeURIComponent(value));
      }
    }

    if (!replacedAny) {
      const parsed = new URL(template);
      for (const [key, value] of Object.entries(replacements)) {
        if (!value) continue;
        parsed.searchParams.set(key, value);
      }
      url = parsed.toString();
    }

    logStep("Ramp receivable link created", { url });

    return new Response(
      JSON.stringify({ success: true, url }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
