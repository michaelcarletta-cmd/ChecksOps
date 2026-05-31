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

function generatePin(phone?: string): string {
  if (phone) {
    // Extract last 4 digits from phone number
    const digitsOnly = phone.replace(/\D/g, "");
    if (digitsOnly.length >= 4) {
      return digitsOnly.slice(-4);
    }
  }
  // Generate random 4-digit PIN
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function getUniquePin(supabaseAdmin: any, phone?: string): Promise<string> {
  let pin = generatePin(phone);
  let attempts = 0;
  const maxAttempts = 50;

  while (attempts < maxAttempts) {
    const { data: existing } = await supabaseAdmin
      .from("client_portal_pins")
      .select("id")
      .eq("pin", pin)
      .maybeSingle();

    if (!existing) return pin;

    // If collision, generate a random PIN instead
    pin = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
  }

  throw new Error("Unable to generate unique PIN");
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

    // Require admin or staff caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: caller, error: callerErr } = await userClient.auth.getUser();
    if (callerErr || !caller?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const { data: callerRoles } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", caller.user.id);
    const allowed = callerRoles?.some((r: any) => r.role === "admin" || r.role === "staff");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden: admin or staff required" }), {
        status: 403, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { email, password, fullName, role, phone }: CreatePortalUserRequest = await req.json();
    if (!["client", "contractor", "referrer"].includes(role)) {
      return new Response(JSON.stringify({ error: "Invalid role" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

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

      // For client role, ensure they have a PIN
      let pin: string | null = null;
      if (role === "client") {
        const { data: existingPin } = await supabaseAdmin
          .from("client_portal_pins")
          .select("pin")
          .eq("user_id", existingUser.id)
          .maybeSingle();

        if (existingPin) {
          pin = existingPin.pin;
        } else {
          pin = await getUniquePin(supabaseAdmin, phone);
          await supabaseAdmin
            .from("client_portal_pins")
            .insert({ user_id: existingUser.id, pin, client_name: fullName });
          console.log("Created PIN for existing user:", pin);
        }
      }

      return new Response(
        JSON.stringify({ success: true, userId: existingUser.id, existingUser: true, passwordUpdated: true, pin }),
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

    // For client role, generate and store a PIN
    let pin: string | null = null;
    if (role === "client" && userData.user) {
      pin = await getUniquePin(supabaseAdmin, phone);
      await supabaseAdmin
        .from("client_portal_pins")
        .insert({ user_id: userData.user.id, pin, client_name: fullName });
      console.log("Created PIN for new user:", pin);
    }

    return new Response(
      JSON.stringify({ success: true, userId: userData.user?.id, pin }),
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
