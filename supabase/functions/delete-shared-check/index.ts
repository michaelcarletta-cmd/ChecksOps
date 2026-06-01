import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  const expected = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
  if (!expected || req.headers.get("x-bridge-secret") !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const { source_check_id } = await req.json();
    if (!source_check_id) return json({ error: "source_check_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: check } = await supabase
      .from("check_intake_items")
      .select("id")
      .eq("external_origin->>source_check_id", source_check_id)
      .maybeSingle();

    if (!check) return json({ ok: true, deleted: 0 }, 404);

    await supabase.from("deposit_items").delete().eq("check_id", check.id);
    await supabase.from("check_endorsements").delete().eq("check_id", check.id);
    await supabase.from("check_payees").delete().eq("check_id", check.id);
    const { error } = await supabase.from("check_intake_items").delete().eq("id", check.id);
    if (error) throw error;

    return json({ ok: true, deleted: 1, check_id: check.id }, 200);
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});

function json(b: unknown, status: number) {
  return new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
