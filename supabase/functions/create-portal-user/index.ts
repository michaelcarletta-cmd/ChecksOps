import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CreatePortalUserRequest {
  email: string;
  password: string;
  fullName: string;
  role: "client" | "contractor" | "referrer";
  phone?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { email, password, fullName, role, phone }: CreatePortalUserRequest = await req.json();

    if (!email || !password || !fullName || !role) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // First check if user already exists
    const { data: existingUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (listError) {
      console.error("Error listing users:", listError);
    }

    const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    if (existingUser) {
      console.log("User already exists with email:", email, "- updating password and returning existing user ID");
      
      // Update the user's password to the new one provided
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
        existingUser.id,
        { password }
      );

      if (updateError) {
        console.error("Error updating user password:", updateError);
        return new Response(
          JSON.stringify({ error: "Failed to update user credentials: " + updateError.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // Ensure user has the role in user_roles table
      const { data: existingRole } = await supabaseAdmin
        .from("user_roles")
        .select("id")
        .eq("user_id", existingUser.id)
        .eq("role", role)
        .maybeSingle();

      if (!existingRole) {
        // Add the role if they don't have it
        await supabaseAdmin
          .from("user_roles")
          .insert({ user_id: existingUser.id, role });
        console.log("Added role", role, "to existing user");
      }

      // Update profile with phone if provided
      if (phone) {
        await supabaseAdmin
          .from("profiles")
          .update({ phone, full_name: fullName })
          .eq("id", existingUser.id);
      }

      return new Response(
        JSON.stringify({ success: true, userId: existingUser.id, existingUser: true, passwordUpdated: true }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create user with admin API (doesn't auto-login the caller)
    const { data: userData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role: role,
      },
    });

    if (createError) {
      console.error("Error creating user:", createError);
      return new Response(
        JSON.stringify({ error: createError.message }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Add role to user_roles table
    if (userData.user) {
      const { error: roleError } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: userData.user.id, role });
      
      if (roleError) {
        console.error("Error adding role:", roleError);
      }
    }

    // Update profile with phone if provided
    if (phone && userData.user) {
      await supabaseAdmin
        .from("profiles")
        .update({ phone })
        .eq("id", userData.user.id);
    }

    return new Response(
      JSON.stringify({ success: true, userId: userData.user?.id }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in create-portal-user:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
