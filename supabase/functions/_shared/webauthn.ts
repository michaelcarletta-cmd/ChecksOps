import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/**
 * Relying-party identity is derived from the caller's Origin so the same
 * deployment works on checksops.com, www.checksops.com and preview hosts.
 * A passkey is scoped to the rpID it was created under, so users registering
 * on the preview host will not see that credential on the apex domain.
 */
export function rpFromRequest(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    host = "";
  }
  if (!host) throw new Error("A valid Origin header is required.");
  return { rpID: host, origin, rpName: "ChecksOps" };
}

/** base64url helpers (Deno has no Buffer). */
export function b64uEncode(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(value: string): Uint8Array {
  const pad = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad.padEnd(pad.length + ((4 - (pad.length % 4)) % 4), "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Store a one-time challenge and return it. */
export async function saveChallenge(
  supabase: ReturnType<typeof serviceClient>,
  args: { challenge: string; purpose: string; email?: string | null; userId?: string | null },
) {
  await supabase.from("webauthn_challenges").insert({
    challenge: args.challenge,
    purpose: args.purpose,
    email: args.email ?? null,
    user_id: args.userId ?? null,
  });
}

/** Fetch + consume a challenge. Returns null when missing, expired or reused. */
export async function consumeChallenge(
  supabase: ReturnType<typeof serviceClient>,
  challenge: string,
  purpose: string,
) {
  const { data } = await supabase
    .from("webauthn_challenges")
    .select("id, email, user_id, expires_at, consumed_at")
    .eq("challenge", challenge)
    .eq("purpose", purpose)
    .maybeSingle();

  if (!data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  await supabase
    .from("webauthn_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", data.id);

  return data;
}

/** Resolve the signed-in user from the Authorization header. */
export async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const supabase = serviceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

/** Look up an auth user by email using the admin API. */
export async function findUserByEmail(
  supabase: ReturnType<typeof serviceClient>,
  email: string,
) {
  const lc = email.trim().toLowerCase();
  let page = 1;
  // listUsers is paginated; ChecksOps user counts are small enough to scan.
  while (page <= 20) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === lc);
    if (hit) return hit;
    if (data.users.length < 200) return null;
    page++;
  }
  return null;
}
