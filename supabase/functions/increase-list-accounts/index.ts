const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("INCREASE_API_KEY");
    const baseUrl = Deno.env.get("INCREASE_BASE_URL") || "https://api.sandbox.increase.com";

    if (!apiKey) throw new Error("INCREASE_API_KEY is not set");

    const resp = await fetch(`${baseUrl}/accounts`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return new Response(JSON.stringify({ success: false, error: errorText }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    return new Response(JSON.stringify({
      success: true,
      accounts: (data.data ?? []).map((a: Record<string, unknown>) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        balance: a.balance,
        currency: a.currency,
        entity_id: a.entity_id,
      })),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
