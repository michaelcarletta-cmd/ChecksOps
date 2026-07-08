import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const {
      tenant_id,
      nickname,
      account_holder_name,
      routing_number,
      account_number,
      account_type,
      entity_type,
      authorize_ach,
    } = body ?? {};

    if (!tenant_id || !account_holder_name || !routing_number || !account_number) {
      throw new Error("tenant_id, account_holder_name, routing_number, and account_number are required");
    }
    if (!/^\d{9}$/.test(routing_number)) throw new Error("routing_number must be 9 digits");
    if (!/^\d{4,17}$/.test(account_number)) throw new Error("account_number must be 4-17 digits");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Membership check
    const { data: membership } = await supabase
      .from("tenant_users")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const keyB64 = Deno.env.get("TENANT_BILLING_ENCRYPTION_KEY");
    if (!keyB64) throw new Error("TENANT_BILLING_ENCRYPTION_KEY not configured");
    const account_number_encrypted = await encrypt(account_number, keyB64);
    const account_number_last4 = account_number.slice(-4);

    const payload = {
      tenant_id,
      nickname: nickname ?? "Operating account",
      account_holder_name,
      routing_number,
      account_number_encrypted,
      account_number_last4,
      account_type: account_type ?? "checking",
      entity_type: entity_type ?? "business",
      verification_status: "pending",
      ach_authorized_at: authorize_ach ? new Date().toISOString() : null,
      ach_authorized_by: authorize_ach ? userData.user.id : null,
      auto_debit_enabled: true,
    };

    const { data, error } = await supabase
      .from("tenant_billing_accounts")
      .upsert(payload, { onConflict: "tenant_id" })
      .select("id, nickname, account_number_last4, account_type, entity_type, verification_status, ach_authorized_at, auto_debit_enabled")
      .single();
    if (error) throw error;

    return new Response(JSON.stringify({ success: true, account: data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[save-tenant-billing-account]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
