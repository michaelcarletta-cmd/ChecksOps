// Save and validate a tenant's OpenAI API key (Pure BYOK)
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
    const { data: userData, error: userErr } = await userClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userErr || !userData?.user) throw new Error("Not authenticated");
    const user = userData.user;

    const body = await req.json();
    const { tenant_id, api_key } = body ?? {};
    if (!tenant_id || typeof tenant_id !== "string") throw new Error("Missing tenant_id");
    if (!api_key || typeof api_key !== "string") throw new Error("Missing api_key");

    const trimmed = api_key.trim();
    if (!trimmed.startsWith("sk-") || trimmed.length < 20) {
      throw new Error("Invalid OpenAI key format (expected sk-...)");
    }

    // Verify caller is a member of the tenant
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: membership, error: memErr } = await admin
      .from("tenant_users")
      .select("user_id")
      .eq("tenant_id", tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (memErr) throw memErr;
    if (!membership) throw new Error("You do not have access to this tenant");

    // Validate the key against OpenAI's /v1/models
    const probe = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    const probeBody = await probe.text();
    if (!probe.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `OpenAI rejected the key (${probe.status}). Verify it's active and has billing.`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const last4 = trimmed.slice(-4);

    // Encrypt + upsert via SECURITY DEFINER helper
    const { data: encResult, error: encErr } = await admin.rpc("encrypt_tenant_openai_key", {
      p_key: trimmed,
    });
    if (encErr) throw encErr;

    const { error: upErr } = await admin
      .from("tenant_openai_credentials")
      .upsert(
        {
          tenant_id,
          encrypted_key: encResult,
          key_last_4: last4,
          status: "active",
          last_validated_at: new Date().toISOString(),
          last_error: null,
          created_by: user.id,
        },
        { onConflict: "tenant_id" }
      );
    if (upErr) throw upErr;

    return new Response(
      JSON.stringify({ ok: true, status: "active", key_last_4: last4 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("tenant-set-openai-key error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
