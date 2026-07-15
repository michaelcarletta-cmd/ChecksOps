import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_EMAIL = "mcarletta@freedomadj.com";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json(401, { error: "Unauthorized" });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !caller) return json(401, { error: "Unauthorized" });

    // Caller must be the platform owner OR have admin role
    const { data: adminRole } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "admin")
      .maybeSingle();

    if (caller.email !== ALLOWED_EMAIL && !adminRole) {
      return json(403, { error: "Admin access required" });
    }

    const { email, full_name, password } = await req.json();
    const cleanEmail = (email || "").trim().toLowerCase();
    const cleanName = (full_name || "").trim();
    if (!cleanEmail || !cleanName) return json(400, { error: "Name and email are required" });

    // Generate a temp password if none provided
    const tempPassword =
      (password && String(password).length >= 8)
        ? String(password)
        : `MortgageOps!${Math.random().toString(36).slice(2, 10)}${Math.floor(Math.random() * 90 + 10)}`;

    // Check if user already exists
    const { data: listData } = await admin.auth.admin.listUsers();
    const existing = listData?.users?.find((u: any) => u.email?.toLowerCase() === cleanEmail);

    let userId: string;
    let created = false;

    if (existing) {
      userId = existing.id;
      // Block if they hold staff/admin (per project rule: mortgage_agent must be scoped-only)
      const { data: roles } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      const conflict = (roles || []).some((r: any) => r.role === "staff" || r.role === "admin");
      if (conflict) {
        return json(400, {
          error:
            "This account already has staff/admin access. Mortgage ops access must be scoped-only — remove those roles first.",
        });
      }
      const already = (roles || []).some((r: any) => r.role === "mortgage_agent");
      if (already) return json(409, { error: "User already has mortgage ops access." });
    } else {
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
        email: cleanEmail,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: cleanName, role: "mortgage_agent" },
      });
      if (createErr) return json(400, { error: createErr.message });
      userId = newUser.user.id;
      created = true;
    }

    // Upsert profile
    await admin.from("profiles").upsert(
      { id: userId, email: cleanEmail, full_name: cleanName },
      { onConflict: "id" }
    );

    // Grant mortgage_agent role
    const { error: roleErr } = await admin
      .from("user_roles")
      .insert({ user_id: userId, role: "mortgage_agent" });
    if (roleErr && !String(roleErr.message).toLowerCase().includes("duplicate")) {
      return json(400, { error: `Failed to grant role: ${roleErr.message}` });
    }

    return json(200, {
      success: true,
      user_id: userId,
      email: cleanEmail,
      full_name: cleanName,
      created,
      temp_password: created ? tempPassword : null,
    });
  } catch (e: any) {
    console.error("hire-mortgage-agent error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
