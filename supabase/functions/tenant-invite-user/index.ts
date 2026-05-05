import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Verify caller
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseClient.auth.getUser(token);
    if (!user) throw new Error("Not authenticated");

    const { tenant_id, email, role } = await req.json();
    if (!tenant_id || !email || !role) throw new Error("Missing tenant_id, email, or role");

    // Verify caller is tenant admin or system admin
    const { data: callerRole } = await supabaseAdmin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();

    const { data: systemRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    const isAuthorized = callerRole?.role === "admin" || systemRole?.role === "admin";
    if (!isAuthorized) throw new Error("Not authorized — must be tenant admin or system admin");

    // Look up tenant for redirect URL
    const { data: tenant } = await supabaseAdmin
      .from("tenants")
      .select("slug, name, custom_domain")
      .eq("id", tenant_id)
      .maybeSingle();

    if (!tenant) throw new Error("Tenant not found");

    // Build the redirect URL — prefer custom_domain, fall back to checksops.com/{slug}
    const tenantBaseUrl = tenant.custom_domain
      ? `https://${tenant.custom_domain}`
      : `https://checksops.com/${tenant.slug}`;
    const redirectTo = `${tenantBaseUrl}/login`;

    // Find or create user by email
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    let targetUser = existingUsers?.users?.find(u => u.email === email.toLowerCase());
    let isNewUser = false;

    if (!targetUser) {
      isNewUser = true;
      // Create user with a temporary password — they'll set their own via the recovery link
      const tempPassword = crypto.randomUUID();
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: email.toLowerCase(),
        password: tempPassword,
        email_confirm: true,
      });
      if (createErr) throw new Error(`Failed to create user: ${createErr.message}`);
      targetUser = newUser.user;
    }

    if (!targetUser) throw new Error("Failed to resolve user");

    // Add to tenant
    const { error: insertErr } = await supabaseAdmin
      .from("tenant_users")
      .upsert({
        tenant_id,
        user_id: targetUser.id,
        role,
      }, { onConflict: "tenant_id,user_id" });

    if (insertErr) throw new Error(`Failed to add user: ${insertErr.message}`);

    // Generate a recovery link so the new user can set their password.
    // This triggers the auth-email-hook (recovery template) and routes the
    // confirmation URL back to the tenant's ChecksOps workspace, NOT the
    // default project site (Freedom CRM).
    const { error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: email.toLowerCase(),
      options: {
        redirectTo: `https://checksops.com/reset-password?next=${encodeURIComponent(redirectTo)}`,
      },
    });

    if (linkError) {
      console.error("Failed to send invite recovery email:", linkError);
      // Don't fail the whole invite — user is added, admin can resend
    }

    return new Response(JSON.stringify({
      success: true,
      user_id: targetUser.id,
      is_new_user: isNewUser,
      invite_sent: !linkError,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
