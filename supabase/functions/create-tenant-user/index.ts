import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify the calling user is authenticated
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Verify caller is admin (app-level)
    const { data: callerRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .in("role", ["admin"])
      .maybeSingle();

    if (!callerRole) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { email, password, full_name, tenant_id, role } = await req.json();

    // Validate inputs
    if (!email || !password || !tenant_id || !role) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: email, password, tenant_id, role" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (!["admin", "operator", "viewer"].includes(role)) {
      return new Response(
        JSON.stringify({ error: "Invalid role. Must be admin, operator, or viewer" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Verify tenant exists
    const { data: tenant } = await supabaseAdmin
      .from("tenants")
      .select("id, name")
      .eq("id", tenant_id)
      .maybeSingle();

    if (!tenant) {
      return new Response(JSON.stringify({ error: "Tenant not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Check if user already exists
    let userId: string;
    const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedFullName = full_name?.trim() || null;

    const existingUser = listData?.users?.find(
      (u: any) => u.email?.toLowerCase() === normalizedEmail
    );

    if (existingUser) {
      userId = existingUser.id;
      console.log("User already exists:", userId);

      // IMPORTANT: if they're already in this tenant, do not mutate auth credentials.
      const { data: existingMembership } = await supabaseAdmin
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("user_id", userId)
        .maybeSingle();

      if (existingMembership) {
        return new Response(
          JSON.stringify({ error: "User is already a member of this tenant" }),
          { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: {
          ...(existingUser.user_metadata ?? {}),
          full_name: normalizedFullName || existingUser.user_metadata?.full_name || null,
          role: "staff",
        },
      });

      if (updateErr) {
        console.error("Error updating existing user:", updateErr);
        return new Response(
          JSON.stringify({ error: `Failed to refresh existing user credentials: ${updateErr.message}` }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    } else {
      // Create auth user
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: normalizedFullName, role: "staff" },
      });

      if (createErr) {
        console.error("Error creating user:", createErr);
        return new Response(
          JSON.stringify({ error: createErr.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      userId = newUser.user.id;
      console.log("Created new user:", userId);
    }

    const { error: profileErr } = await supabaseAdmin.from("profiles").upsert({
      id: userId,
      full_name: normalizedFullName || existingUser?.user_metadata?.full_name || null,
      email: normalizedEmail,
    }, { onConflict: "id" });

    if (profileErr) {
      console.error("Error upserting profile:", profileErr);
      return new Response(
        JSON.stringify({ error: `Failed to save profile: ${profileErr.message}` }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Add to tenant
    const { error: insertErr } = await supabaseAdmin
      .from("tenant_users")
      .insert({ tenant_id, user_id: userId, role });

    if (insertErr) {
      console.error("Error adding to tenant:", insertErr);
      return new Response(
        JSON.stringify({ error: insertErr.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Ensure user has a user_role entry for tenant_user
    await supabaseAdmin.from("user_roles").upsert(
      { user_id: userId, role: "staff" },
      { onConflict: "user_id,role" }
    );

    console.log(`Added user ${userId} to tenant ${tenant_id} as ${role}`);

    return new Response(
      JSON.stringify({
        success: true,
        user_id: userId,
        email,
        password,
        userName: full_name,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in create-tenant-user:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
