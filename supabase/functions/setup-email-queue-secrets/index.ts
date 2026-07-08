import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// One-time infra fix: stores this project's own URL and service-role key
// into vault as 'supabase_url' / 'supabase_service_role_key', so pg_cron jobs
// (process-email-queue, checkalt-poll-status) can authenticate their
// net.http_post calls. Uses this function's own automatically-provided
// environment variables — nobody needs to locate or paste the actual key.
//
// No admin/user auth required: the only action possible is overwriting these
// two specific vault entries with this function's own already-correct
// values (nothing caller-controlled, nothing secret returned), so it's safe
// to leave callable with just the project's public API key. Requires
// verify_jwt = false in config.toml.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const { error: urlErr } = await supabase.rpc("set_vault_secret", {
      secret_name: "supabase_url",
      secret_value: supabaseUrl,
    });
    if (urlErr) throw new Error(`Failed to set supabase_url secret: ${urlErr.message}`);

    const { error: keyErr } = await supabase.rpc("set_vault_secret", {
      secret_name: "supabase_service_role_key",
      secret_value: serviceRoleKey,
    });
    if (keyErr) throw new Error(`Failed to set supabase_service_role_key secret: ${keyErr.message}`);

    return new Response(
      JSON.stringify({ success: true, message: "Vault secrets configured. Cron jobs should authenticate successfully within 5-10 seconds." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[setup-email-queue-secrets]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
