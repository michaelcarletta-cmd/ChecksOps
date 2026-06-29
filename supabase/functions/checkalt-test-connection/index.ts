// Lightweight CheckAlt connectivity check — authenticates against FinCapture
// and returns success/failure. Used by the admin Integration Settings UI.
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { getServiceClient, loadConfig, getCheckAltJwt } from "../_shared/checkalt.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const token = authHeader.replace("Bearer ", "");
    const { data: claims } = await supabase.auth.getClaims(token);
    const userId = claims?.claims?.sub;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isPlatformAdmin } = await supabase.rpc("has_role", {
      _user_id: userId, _role: "admin",
    });
    if (!isPlatformAdmin) {
      return new Response(JSON.stringify({ error: "Admins only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cfg = await loadConfig(supabase);
    const jwt = await getCheckAltJwt(supabase, cfg);

    return new Response(
      JSON.stringify({
        success: true,
        message: "CheckAlt authentication succeeded",
        token_preview: jwt.slice(0, 12) + "…",
        base_url: cfg.base_url,
        merchant: cfg.merchant,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-test-connection]", msg);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
