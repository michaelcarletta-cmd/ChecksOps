// Returns the 1ESX product catalog (report types, facets, pitches, expedited fee). Admins only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { onesxFetch } from "../_shared/onesx.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "Admin access required" }, 403);

    const resp = await onesxFetch("/product", { method: "GET" });
    if (!resp.body?.success) {
      return json({ error: resp.body?.message ?? "1ESX product fetch failed", details: resp.body }, resp.status || 502);
    }
    return json({ success: true, data: resp.body.data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[onesx-products]", msg);
    return json({ error: msg }, 500);
  }
});
