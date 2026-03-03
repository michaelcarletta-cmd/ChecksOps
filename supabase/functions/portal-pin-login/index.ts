import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const { pin } = await req.json();

    if (!pin || !/^\d{4}$/.test(pin)) {
      return new Response(
        JSON.stringify({ error: "Please enter a valid 4-digit PIN" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Look up the PIN
    const { data: pinRecord, error: pinError } = await supabaseAdmin
      .from("client_portal_pins")
      .select("user_id, client_name")
      .eq("pin", pin)
      .maybeSingle();

    if (pinError || !pinRecord) {
      console.log("PIN lookup failed:", pin, pinError);
      return new Response(
        JSON.stringify({ error: "Invalid PIN. Please check your PIN and try again." }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get the user's email
    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(pinRecord.user_id);

    if (userError || !userData?.user?.email) {
      console.error("User lookup failed:", userError);
      return new Response(
        JSON.stringify({ error: "Account not found. Please contact support." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Generate a magic link for the user
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });

    if (linkError || !linkData) {
      console.error("Magic link generation failed:", linkError);
      return new Response(
        JSON.stringify({ error: "Login failed. Please try again." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Extract the token hash and return it for client-side OTP verification
    const properties = linkData.properties;

    return new Response(
      JSON.stringify({
        success: true,
        token_hash: properties.hashed_token,
        email: userData.user.email,
        client_name: pinRecord.client_name,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in portal-pin-login:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
