import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: "service_unavailable" }, 503);
  }

  const token = authHeader.slice("Bearer ".length);
  const authClient = createClient(supabaseUrl, anonKey);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: callerData, error: callerError } = await authClient.auth.getUser(token);
  if (callerError || !callerData.user) return json({ error: "unauthorized" }, 401);

  const { data: adminRole, error: roleError } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", callerData.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (roleError) return json({ error: "authorization_check_failed" }, 500);
  if (!adminRole) return json({ error: "forbidden" }, 403);

  let body: { user_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return json({ error: "invalid_user_id" }, 400);
  }

  const { data: factorsData, error: factorsError } =
    await adminClient.auth.admin.mfa.listFactors({ userId });
  if (factorsError) return json({ error: "factor_lookup_failed" }, 500);

  const totpFactors = factorsData?.factors?.filter((factor) => factor.factor_type === "totp") ?? [];
  for (const factor of totpFactors) {
    const { error: deleteError } = await adminClient.auth.admin.mfa.deleteFactor({
      userId,
      id: factor.id,
    });
    if (deleteError) return json({ error: "factor_reset_failed" }, 500);
  }

  const { error: profileError } = await adminClient
    .from("profiles")
    .update({ totp_enrolled_at: null })
    .eq("id", userId);
  if (profileError) return json({ error: "profile_sync_failed" }, 500);

  return json({ success: true, removed_count: totpFactors.length });
});