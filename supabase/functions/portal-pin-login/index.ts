import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleCors, jsonResponse, errorResponse } from "../_shared/http.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { pin } = await req.json();

    if (!pin || !/^\d{4}$/.test(pin)) {
      return errorResponse("Please enter a valid 4-digit PIN", 400);
    }


    // Strategy 1: Check client_portal_pins table first
    const { data: pinRecord } = await supabaseAdmin
      .from("client_portal_pins")
      .select("user_id, client_name")
      .eq("pin", pin)
      .maybeSingle();

    if (pinRecord) {
      // Found in PIN table - try to sign them in
      const result = await signInUser(supabaseAdmin, pinRecord.user_id, pinRecord.client_name);
      if (result.success) {
        return jsonResponse(result);
      }
      // If auth user doesn't exist, fall through to Strategy 2
      console.log("PIN record found but auth user missing, trying phone lookup");
    }

    // Strategy 2: Match PIN against last 4 digits of client phone numbers
    const { data: clients, error: clientsError } = await supabaseAdmin
      .from("clients")
      .select("id, name, email, phone, user_id")
      .not("phone", "is", null);

    if (clientsError) {
      return errorResponse("Login failed. Please try again.", 500, clientsError);
    }

    // Find client whose phone ends with the PIN
    const matchingClient = clients?.find((c: any) => {
      if (!c.phone) return false;
      const digits = c.phone.replace(/\D/g, "");
      return digits.length >= 4 && digits.slice(-4) === pin;
    });

    if (!matchingClient) {
      console.log("No client found with phone ending in:", pin);
      return errorResponse("Invalid PIN. Please check your PIN and try again.", 401);
    }

    console.log("Found client by phone match:", matchingClient.name, matchingClient.email);

    // Ensure auth user exists
    let authUserId = matchingClient.user_id;

    // Check if the auth user actually exists
    if (authUserId) {
      const { data: existingUser, error: getUserErr } = await supabaseAdmin.auth.admin.getUserById(authUserId);
      if (getUserErr || !existingUser?.user) {
        console.log("user_id in clients table doesn't exist in auth, will create new");
        authUserId = null;
      }
    }

    // Create auth user if needed
    if (!authUserId) {
      const tempPassword = `Pin${pin}${Date.now()}!`;
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: matchingClient.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: matchingClient.name,
          role: "client",
        },
      });

      if (createErr) {
        // If user already exists in auth with this email, find them
        if (createErr.message?.includes("already been registered") || createErr.message?.includes("already exists")) {
          const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
          const existing = listData?.users?.find(
            (u: any) => u.email?.toLowerCase() === matchingClient.email.toLowerCase()
          );
          if (existing) {
            authUserId = existing.id;
            console.log("Found existing auth user by email:", authUserId);
          } else {
            return errorResponse("Account setup issue. Please contact support.", 500, {
              email: matchingClient.email,
            });
          }
        } else {
          return errorResponse("Account setup issue. Please contact support.", 500, createErr);
        }
      } else {
        authUserId = newUser.user.id;
        console.log("Created new auth user:", authUserId);
      }

      // Ensure client role exists
      await supabaseAdmin.from("user_roles").upsert(
        { user_id: authUserId, role: "client" },
        { onConflict: "user_id,role" }
      );

      // Update clients table with auth user_id
      await supabaseAdmin
        .from("clients")
        .update({ user_id: authUserId })
        .eq("id", matchingClient.id);
    }

    // Save PIN to client_portal_pins for faster lookup next time
    await supabaseAdmin.from("client_portal_pins").upsert(
      { user_id: authUserId, pin, client_name: matchingClient.name },
      { onConflict: "pin" }
    );

    // Sign them in
    const result = await signInUser(supabaseAdmin, authUserId, matchingClient.name);
    if (!result.success) {
      return errorResponse(result.error || "Login failed", 500);
    }

    return jsonResponse(result);
  } catch (error: any) {
    return errorResponse(error.message ?? "Internal error", 500, error);
  }
});

async function signInUser(supabaseAdmin: any, userId: string, clientName: string) {
  try {
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (userError || !userData?.user?.email) {
      console.error("User lookup failed for sign-in:", userId, userError);
      return { success: false, error: "Account not found" };
    }

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });

    if (linkError || !linkData) {
      console.error("Magic link generation failed:", linkError);
      return { success: false, error: "Login failed" };
    }

    return {
      success: true,
      token_hash: linkData.properties.hashed_token,
      email: userData.user.email,
      client_name: clientName,
    };
  } catch (err: any) {
    console.error("signInUser error:", err);
    return { success: false, error: err.message };
  }
}
