// One-off bootstrap: creates a confirmed admin user for ChecksOps testing.
// Safe to call multiple times — returns the existing user if already present.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: "email and password are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Try to create; if it exists, look it up.
    let userId: string | null = null;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr) {
      const msg = createErr.message?.toLowerCase() ?? "";
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        // Find the existing user
        const { data: list, error: listErr } = await admin.auth.admin.listUsers();
        if (listErr) throw listErr;
        const existing = list.users.find(
          (u) => u.email?.toLowerCase() === String(email).toLowerCase(),
        );
        if (!existing) throw createErr;
        userId = existing.id;

        // Reset password + confirm email so the caller can sign in immediately.
        const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
        });
        if (updErr) throw updErr;
      } else {
        throw createErr;
      }
    } else {
      userId = created.user!.id;
    }

    return new Response(
      JSON.stringify({ user_id: userId, email }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
