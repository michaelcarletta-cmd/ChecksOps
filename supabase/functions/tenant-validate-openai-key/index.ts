// Re-validate a tenant's stored OpenAI key
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!userData?.user) throw new Error("Not authenticated");
    const user = userData.user;

    const { tenant_id } = await req.json();
    if (!tenant_id) throw new Error("Missing tenant_id");

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: membership } = await admin
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) throw new Error("Not a member of this tenant");

    const { data: key, error: decErr } = await admin.rpc("decrypt_tenant_openai_key", {
      p_tenant: tenant_id,
    });
    if (decErr) throw decErr;
    if (!key) {
      return new Response(JSON.stringify({ ok: false, error: "No key on file" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const probe = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    await probe.text();

    const newStatus = probe.ok ? "active" : "invalid";
    const errMsg = probe.ok ? null : `OpenAI returned ${probe.status}`;

    await admin
      .from("tenant_openai_credentials")
      .update({
        status: newStatus,
        last_validated_at: new Date().toISOString(),
        last_error: errMsg,
      })
      .eq("tenant_id", tenant_id);

    return new Response(
      JSON.stringify({ ok: probe.ok, status: newStatus, error: errMsg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("tenant-validate-openai-key error:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
