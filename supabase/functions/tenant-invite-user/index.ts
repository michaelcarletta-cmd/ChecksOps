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

    const { tenant_id, email, role, full_name } = await req.json();
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

    const tenantBaseUrl = tenant.custom_domain
      ? `https://${tenant.custom_domain}`
      : `https://checksops.com/${tenant.slug}`;
    const redirectTo = `${tenantBaseUrl}/login`;
    const inviteRedirect = `https://checksops.com/reset-password?next=${encodeURIComponent(redirectTo)}`;

    const lowerEmail = email.toLowerCase();

    // Find or create user by email
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    let targetUser = existingUsers?.users?.find((u) => u.email === lowerEmail);
    let isNewUser = false;
    let inviteSent = false;
    let inviteError: string | null = null;

    if (!targetUser) {
      isNewUser = true;
      // inviteUserByEmail creates the user AND sends the invite email
      // (triggers auth-email-hook with the 'invite' template).
      const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        lowerEmail,
        {
          redirectTo: inviteRedirect,
          data: { full_name: full_name || null },
        }
      );
      if (inviteErr) {
        // Fall back to createUser so the user exists even if email failed
        const tempPassword = crypto.randomUUID();
        const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email: lowerEmail,
          password: tempPassword,
          email_confirm: true,
          user_metadata: { full_name: full_name || null },
        });
        if (createErr) throw new Error(`Failed to create user: ${createErr.message}`);
        targetUser = newUser.user;
        inviteError = inviteErr.message;
      } else {
        targetUser = invited.user;
        inviteSent = true;
      }
    } else {
      // Existing user — actually send a recovery email so they can join the new tenant.
      // generateLink only creates a link server-side and does not deliver an email.
      const { error: resetErr } = await supabaseClient.auth.resetPasswordForEmail(lowerEmail, {
        redirectTo: inviteRedirect,
      });
      if (!resetErr) inviteSent = true;
      else inviteError = resetErr.message;
    }

    if (!targetUser) throw new Error("Failed to resolve user");

    // Ensure a profile row exists so the user shows up by email/name in the UI
    // (instead of falling back to the raw UUID).
    await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          id: targetUser.id,
          email: lowerEmail,
          full_name: full_name || targetUser.user_metadata?.full_name || null,
        },
        { onConflict: "id" }
      );

    // Add to tenant
    const { error: insertErr } = await supabaseAdmin
      .from("tenant_users")
      .upsert(
        { tenant_id, user_id: targetUser.id, role },
        { onConflict: "tenant_id,user_id" }
      );

    if (insertErr) throw new Error(`Failed to add user: ${insertErr.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        user_id: targetUser.id,
        is_new_user: isNewUser,
        invite_sent: inviteSent,
        invite_error: inviteError,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
