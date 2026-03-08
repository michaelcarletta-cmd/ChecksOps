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
    const baseUrl = Deno.env.get("INCREASE_BASE_URL");

    if (!apiKey) throw new Error("INCREASE_API_KEY is not set");
    if (!baseUrl) throw new Error("INCREASE_BASE_URL is not set");

    console.log(`[INCREASE-HEALTH-CHECK] Calling ${baseUrl}/accounts`);

    const resp = await fetch(`${baseUrl}/accounts`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[INCREASE-HEALTH-CHECK] API error ${resp.status}: ${errorText}`);
      return new Response(JSON.stringify({ success: false, status: resp.status, error: errorText }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    console.log(`[INCREASE-HEALTH-CHECK] Success — ${data.data?.length ?? 0} accounts returned`);

    return new Response(JSON.stringify({ success: true, accounts: data.data, total: data.data?.length ?? 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[INCREASE-HEALTH-CHECK] ERROR: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
