import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const bridgeSecret = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
    if (!bridgeSecret) {
      return new Response(
        JSON.stringify({ error: "CROSS_APP_BRIDGE_SECRET env not set" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Check if it already exists
    const { data: existing } = await supabase
      .schema("vault" as any)
      .from("secrets")
      .select("id, name")
      .eq("name", "CROSS_APP_BRIDGE_SECRET")
      .maybeSingle();

    let result;
    if (existing?.id) {
      const { data, error } = await supabase.rpc("vault_update_bridge_secret", {
        _secret: bridgeSecret,
      });
      if (error) throw error;
      result = { action: "updated", data };
    } else {
      const { data, error } = await supabase.rpc("vault_create_bridge_secret", {
        _secret: bridgeSecret,
      });
      if (error) throw error;
      result = { action: "created", data };
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
