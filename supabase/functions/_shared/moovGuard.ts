import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bindMoovEnvironment, moovConfigured, moovEnvironment } from "./moovClient.ts";

/**
 * Safety for every Moov edge function.
 *
 * Moov is generally available to every ChecksOps tenant. It runs when:
 *   1. MOOV_ENABLED is not explicitly "false"  (emergency kill switch)
 *   2. Moov API credentials exist for the tenant's environment
 *
 * There is no Freedom-only, pilot, or per-tenant allowlist. Identity/KYB,
 * ToS, bank verification, wallet, and capability checks still apply before
 * money movement. Actum and Plaid never reach this code path.
 */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-moov-signature, x-moov-timestamp, webhook-id, webhook-timestamp, webhook-signature",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export function moovGloballyEnabled(env: { get(name: string): string | undefined } = Deno.env): boolean {
  const raw = env.get("MOOV_ENABLED");
  if (raw == null || raw === "") return true;
  return raw.toLowerCase() === "true";
}

export interface MoovCaller {
  userId: string;
  tenantId: string;
  isAdmin: boolean;
  environment: string;
  supabase: SupabaseClient;
}

/**
 * Authenticates the caller, confirms tenant membership, and enforces the
 * global kill switch + credential presence. Every tenant may use Moov.
 */
export async function requireMoovCaller(
  req: Request,
  tenantId: string,
  opts: { requireAdmin?: boolean } = {},
): Promise<MoovCaller | Response> {
  if (!moovGloballyEnabled()) {
    return json({ error: "This payment provider is not enabled." }, 403);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;

  const supabase = serviceClient();

  // Tenant membership — this is what stops cross-tenant access.
  const { data: membership } = await supabase
    .from("tenant_users")
    .select("tenant_id, role")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  const isAdmin = !!adminRole;

  if (!membership && !isAdmin) return json({ error: "Forbidden" }, 403);
  if (opts.requireAdmin && !isAdmin) {
    return json({ error: "Administrator access required" }, 403);
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, moov_environment")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) return json({ error: "Organization not found" }, 404);

  // Per-tenant environment: test tenants run against Moov's sandbox ledger so
  // no real money moves, while live tenants stay on production credentials.
  let environment: string;
  try {
    const tenantEnv = ((tenant as any).moov_environment ?? "").toLowerCase();
    if (tenantEnv === "sandbox" || tenantEnv === "production") {
      bindMoovEnvironment(tenantEnv);
    }
    environment = moovEnvironment();
  } catch (e) {
    return json({ error: (e as Error).message }, 503);
  }

  if (!moovConfigured(environment)) {
    return json(
      {
        error: environment === "sandbox"
          ? "Sandbox payment credentials are not configured for this test organization."
          : "Payment provider credentials are not configured.",
      },
      503,
    );
  }

  return { userId, tenantId, isAdmin, environment, supabase };
}

/**
 * Binds the Moov environment for flows that have no signed-in caller
 * (recipient setup links, webhooks, background jobs). Test tenants resolve to
 * the sandbox ledger; everyone else stays on production credentials.
 */
export async function bindTenantMoovEnvironment(
  supabase: SupabaseClient,
  tenantId: string | null | undefined,
): Promise<string> {
  if (tenantId) {
    const { data } = await supabase
      .from("tenants")
      .select("moov_environment")
      .eq("id", tenantId)
      .maybeSingle();
    const tenantEnv = ((data as any)?.moov_environment ?? "").toLowerCase();
    if (tenantEnv === "sandbox" || tenantEnv === "production") {
      bindMoovEnvironment(tenantEnv);
    }
  }
  return moovEnvironment();
}

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

/** Appends a safe, non-sensitive row to the internal payment event log. */
export async function logPaymentEvent(
  supabase: SupabaseClient,
  row: {
    tenant_id?: string | null;
    recipient_id?: string | null;
    transfer_id?: string | null;
    provider_transfer_id?: string | null;
    event_type: string;
    previous_status?: string | null;
    new_status?: string | null;
    provider_metadata?: Record<string, unknown>;
    environment?: string;
  },
) {
  const { error } = await supabase.from("payment_event_log").insert({
    provider: "moov",
    environment: row.environment ?? (Deno.env.get("MOOV_ENVIRONMENT") ?? "sandbox").toLowerCase(),
    tenant_id: row.tenant_id ?? null,
    recipient_id: row.recipient_id ?? null,
    transfer_id: row.transfer_id ?? null,
    provider_transfer_id: row.provider_transfer_id ?? null,
    event_type: row.event_type,
    previous_status: row.previous_status ?? null,
    new_status: row.new_status ?? null,
    provider_metadata: sanitize(row.provider_metadata ?? {}),
  });
  if (error) console.error("[moov] event log insert failed", error.message);
}

const SENSITIVE = [
  "accountnumber", "routingnumber", "ssn", "taxid", "password", "secret",
  "token", "accesstoken", "cardnumber", "cvv", "fullaccountnumber",
];

/** Strips anything that looks like raw banking or credential data. */
export function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitize) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE.includes(k.toLowerCase().replace(/[_-]/g, ""))) continue;
      out[k] = sanitize(v);
    }
    return out as unknown as T;
  }
  return value;
}
